/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
import is from '@sindresorhus/is';
import yaml from 'js-yaml';
import { WORKER_FILE_UPDATE_FAILED } from '../../../../constants/error-messages';
import { logger } from '../../../../logger';
import { get } from '../../../../modules/manager';
import type {
  ArtifactError,
  ArtifactNotice,
  PackageDependency,
  PackageFile,
  UpdateArtifact,
  UpdateArtifactsConfig,
  UpdateArtifactsResult,
} from '../../../../modules/manager/types';
import { getFile } from '../../../../util/git';
import type { FileAddition, FileChange } from '../../../../util/git/types';
import { coerceString } from '../../../../util/string';
import type { BranchConfig, BranchUpgradeConfig } from '../../../types';
import { doAutoReplace } from './auto-replace';

export interface PackageFilesResult {
  artifactErrors: ArtifactError[];
  reuseExistingBranch?: boolean;
  updatedPackageFiles: FileChange[];
  updatedArtifacts: FileChange[];
  artifactNotices: ArtifactNotice[];
}

async function getFileContent(
  updatedFileContents: Record<string, string>,
  filePath: string,
  config: BranchConfig,
): Promise<string | null> {
  let fileContent: string | null = updatedFileContents[filePath];
  if (!fileContent) {
    fileContent = await getFile(
      filePath,
      config.reuseExistingBranch ? config.branchName : config.baseBranch,
    );
  }
  return fileContent;
}

function sortPackageFiles<T extends FilePath>(
  config: BranchConfig,
  manager: string,
  packageFiles: T[],
): void {
  const managerPackageFiles = config.packageFiles?.[manager];
  if (!managerPackageFiles) {
    return;
  }
  packageFiles.sort((lhs, rhs) => {
    const lhsIndex = managerPackageFiles.findIndex(
      (entry) => entry.packageFile === lhs.path,
    );
    const rhsIndex = managerPackageFiles.findIndex(
      (entry) => entry.packageFile === rhs.path,
    );
    return lhsIndex - rhsIndex;
  });
}

function hasAny(set: Set<string>, targets: Iterable<string>): boolean {
  for (const target of targets) {
    if (set.has(target)) {
      return true;
    }
  }
  return false;
}

type FilePath = Pick<FileChange, 'path'>;

function getManagersForPackageFiles<T extends FilePath>(
  packageFiles: T[],
  managerPackageFiles: Record<string, Set<string>>,
): Set<string> {
  const packageFileNames = packageFiles.map((packageFile) => packageFile.path);
  return new Set(
    Object.keys(managerPackageFiles).filter((manager) =>
      hasAny(managerPackageFiles[manager], packageFileNames),
    ),
  );
}

function getPackageFilesForManager<T extends FilePath>(
  packageFiles: T[],
  managerPackageFiles: Set<string>,
): T[] {
  return packageFiles.filter((packageFile) =>
    managerPackageFiles.has(packageFile.path),
  );
}

export async function getUpdatedPackageFiles(
  config: BranchConfig,
): Promise<PackageFilesResult> {
  logger.trace({ config });
  const reuseExistingBranch = config.reuseExistingBranch!;
  logger.debug(
    `manager.getUpdatedPackageFiles() reuseExistingBranch=${reuseExistingBranch}`,
  );
  let updatedFileContents: Record<string, string> = {};
  const nonUpdatedFileContents: Record<string, string> = {};
  const managerPackageFiles: Record<string, Set<string>> = {};
  const packageFileUpdatedDeps: Record<string, PackageDependency[]> = {};
  const lockFileMaintenanceFiles: string[] = [];
  let firstUpdate = true;
  for (const upgrade of config.upgrades) {
    const manager = upgrade.manager!;
    const packageFile = upgrade.packageFile!;
    const depName = upgrade.depName!;
    // TODO: fix types, can be undefined (#22198)
    const newVersion = upgrade.newVersion!;
    const currentVersion = upgrade.currentVersion!;
    const updateLockedDependency = get(manager, 'updateLockedDependency')!;
    managerPackageFiles[manager] ??= new Set<string>();
    managerPackageFiles[manager].add(packageFile);
    packageFileUpdatedDeps[packageFile] ??= [];
    packageFileUpdatedDeps[packageFile].push({ ...upgrade });
    const packageFileContent = await getFileContent(
      updatedFileContents,
      packageFile,
      config,
    );
    let lockFileContent: string | null = null;
    const lockFile = upgrade.lockFile ?? upgrade.lockFiles?.[0] ?? '';
    if (lockFile) {
      lockFileContent = await getFileContent(
        updatedFileContents,
        lockFile,
        config,
      );
    }
    // istanbul ignore if
    if (
      reuseExistingBranch &&
      (!packageFileContent || (lockFile && !lockFileContent))
    ) {
      logger.debug(
        { packageFile, depName },
        'Rebasing branch after file not found',
      );
      return getUpdatedPackageFiles({
        ...config,
        reuseExistingBranch: false,
      });
    }
    if (upgrade.updateType === 'lockFileMaintenance') {
      lockFileMaintenanceFiles.push(packageFile);
    } else if (upgrade.isRemediation) {
      const { status, files } = await updateLockedDependency({
        ...upgrade,
        depName,
        newVersion,
        currentVersion,
        packageFile,
        packageFileContent: packageFileContent!,
        lockFile,
        lockFileContent: lockFileContent!,
        allowParentUpdates: true,
        allowHigherOrRemoved: true,
      });
      if (reuseExistingBranch && status !== 'already-updated') {
        logger.debug(
          { lockFile, depName, status },
          'Need to retry branch as it is not already up-to-date',
        );
        return getUpdatedPackageFiles({
          ...config,
          reuseExistingBranch: false,
        });
      }
      if (files) {
        updatedFileContents = { ...updatedFileContents, ...files };
        Object.keys(files).forEach(
          (file) => delete nonUpdatedFileContents[file],
        );
      }
      if (status === 'update-failed' || status === 'unsupported') {
        upgrade.remediationNotPossible = true;
      }
    } else if (upgrade.isLockfileUpdate) {
      if (updateLockedDependency) {
        const { status, files } = await updateLockedDependency({
          ...upgrade,
          depName,
          newVersion,
          currentVersion,
          packageFile,
          packageFileContent: packageFileContent!,
          lockFile,
          lockFileContent: lockFileContent!,
          allowParentUpdates: false,
        });
        if (status === 'unsupported') {
          // incompatible lock file
          if (!updatedFileContents[packageFile]) {
            nonUpdatedFileContents[packageFile] = packageFileContent!;
          }
        } else if (status === 'already-updated') {
          logger.debug(
            `Upgrade of ${depName} to ${newVersion} is already done in existing branch`,
          );
        } else {
          // something changed
          if (reuseExistingBranch) {
            logger.debug(
              { lockFile, depName, status },
              'Need to retry branch as upgrade requirements are not mets',
            );
            return getUpdatedPackageFiles({
              ...config,
              reuseExistingBranch: false,
            });
          }
          if (files) {
            updatedFileContents = { ...updatedFileContents, ...files };
            Object.keys(files).forEach(
              (file) => delete nonUpdatedFileContents[file],
            );
          }
        }
      } else {
        logger.debug(
          { manager },
          'isLockFileUpdate without updateLockedDependency',
        );
        if (!updatedFileContents[packageFile]) {
          nonUpdatedFileContents[packageFile] = packageFileContent!;
        }
      }
    } else {
      const updateDependency = get(manager, 'updateDependency');
      if (!updateDependency) {
        let res = await doAutoReplace(
          upgrade,
          packageFileContent!,
          reuseExistingBranch,
          firstUpdate,
        );
        firstUpdate = false;
        if (res) {
          res = await applyManagerBumpPackageVersion(res, upgrade);
          if (res === packageFileContent) {
            logger.debug({ packageFile, depName }, 'No content changed');
          } else {
            logger.debug({ packageFile, depName }, 'Contents updated');
            updatedFileContents[packageFile] = res!;
            delete nonUpdatedFileContents[packageFile];
          }
          continue;
        } else if (reuseExistingBranch) {
          return getUpdatedPackageFiles({
            ...config,
            reuseExistingBranch: false,
          });
        }
        logger.error({ packageFile, depName }, 'Could not autoReplace');
        throw new Error(WORKER_FILE_UPDATE_FAILED);
      }
      let newContent = await updateDependency({
        fileContent: packageFileContent!,
        upgrade,
      });
      newContent = await applyManagerBumpPackageVersion(newContent, upgrade);
      if (!newContent) {
        if (reuseExistingBranch) {
          logger.debug(
            { packageFile, depName },
            'Rebasing branch after error updating content',
          );
          return getUpdatedPackageFiles({
            ...config,
            reuseExistingBranch: false,
          });
        }
        logger.debug(
          { existingContent: packageFileContent, config: upgrade },
          'Error updating file',
        );
        throw new Error(WORKER_FILE_UPDATE_FAILED);
      }
      if (newContent !== packageFileContent) {
        if (reuseExistingBranch) {
          // This ensure it's always 1 commit from the bot
          logger.debug(
            { packageFile, depName },
            'Need to update package file so will rebase first',
          );
          return getUpdatedPackageFiles({
            ...config,
            reuseExistingBranch: false,
          });
        }
        logger.debug(
          `Updating ${depName} in ${coerceString(packageFile, lockFile)}`,
        );
        updatedFileContents[packageFile] = newContent;
        delete nonUpdatedFileContents[packageFile];
      }
      if (newContent === packageFileContent) {
        if (upgrade.manager === 'git-submodules') {
          updatedFileContents[packageFile] = newContent;
          delete nonUpdatedFileContents[packageFile];
        }
      }
    }
  }
  const updatedPackageFiles: FileAddition[] = Object.keys(
    updatedFileContents,
  ).map((name) => ({
    type: 'addition',
    path: name,
    contents: updatedFileContents[name],
  }));
  const updatedArtifacts: FileChange[] = [];
  const artifactErrors: ArtifactError[] = [];
  const artifactNotices: ArtifactNotice[] = [];
  if (is.nonEmptyArray(updatedPackageFiles)) {
    logger.debug('updateArtifacts for updatedPackageFiles');
    const updatedPackageFileManagers = getManagersForPackageFiles(
      updatedPackageFiles,
      managerPackageFiles,
    );
    for (const manager of updatedPackageFileManagers) {
      const packageFilesForManager = getPackageFilesForManager(
        updatedPackageFiles,
        managerPackageFiles[manager],
      );
      sortPackageFiles(config, manager, packageFilesForManager);
      for (const packageFile of packageFilesForManager) {
        const updatedDeps = packageFileUpdatedDeps[packageFile.path];
        const results = await managerUpdateArtifacts(manager, {
          packageFileName: packageFile.path,
          updatedDeps,
          // TODO #22198
          newPackageFileContent: packageFile.contents!.toString(),
          config: patchConfigForArtifactsUpdate(
            config,
            manager,
            packageFile.path,
          ),
        });
        processUpdateArtifactResults(
          results,
          updatedArtifacts,
          artifactErrors,
          artifactNotices,
        );
      }
    }
  }
  const nonUpdatedPackageFiles: FileAddition[] = Object.keys(
    nonUpdatedFileContents,
  ).map((name) => ({
    type: 'addition',
    path: name,
    contents: nonUpdatedFileContents[name],
  }));
  if (is.nonEmptyArray(nonUpdatedPackageFiles)) {
    logger.debug('updateArtifacts for nonUpdatedPackageFiles');
    const nonUpdatedPackageFileManagers = getManagersForPackageFiles(
      nonUpdatedPackageFiles,
      managerPackageFiles,
    );
    for (const manager of nonUpdatedPackageFileManagers) {
      const packageFilesForManager = getPackageFilesForManager(
        nonUpdatedPackageFiles,
        managerPackageFiles[manager],
      );
      sortPackageFiles(config, manager, packageFilesForManager);
      for (const packageFile of packageFilesForManager) {
        const updatedDeps = packageFileUpdatedDeps[packageFile.path];
        const results = await managerUpdateArtifacts(manager, {
          packageFileName: packageFile.path,
          updatedDeps,
          // TODO #22198
          newPackageFileContent: packageFile.contents!.toString(),
          config: patchConfigForArtifactsUpdate(
            config,
            manager,
            packageFile.path,
          ),
        });
        processUpdateArtifactResults(
          results,
          updatedArtifacts,
          artifactErrors,
          artifactNotices,
        );
        if (is.nonEmptyArray(results)) {
          updatedPackageFiles.push(packageFile);
        }
      }
    }
  }
  if (!reuseExistingBranch) {
    const lockFileMaintenancePackageFiles: FilePath[] =
      lockFileMaintenanceFiles.map((name) => ({
        path: name,
      }));
    // Only perform lock file maintenance if it's a fresh commit
    if (is.nonEmptyArray(lockFileMaintenanceFiles)) {
      logger.debug('updateArtifacts for lockFileMaintenanceFiles');
      const lockFileMaintenanceManagers = getManagersForPackageFiles(
        lockFileMaintenancePackageFiles,
        managerPackageFiles,
      );
      for (const manager of lockFileMaintenanceManagers) {
        const packageFilesForManager = getPackageFilesForManager(
          lockFileMaintenancePackageFiles,
          managerPackageFiles[manager],
        );
        sortPackageFiles(config, manager, packageFilesForManager);
        for (const packageFile of packageFilesForManager) {
          const contents =
            updatedFileContents[packageFile.path] ||
            (await getFile(packageFile.path, config.baseBranch));

          const results = await managerUpdateArtifacts(manager, {
            packageFileName: packageFile.path,
            updatedDeps: [],
            newPackageFileContent: contents!,
            config: patchConfigForArtifactsUpdate(
              config,
              manager,
              packageFile.path,
            ),
          });

          if (
            manager === 'rpmtest' &&
            config.branchTopic === 'security-lock-file-maintenance'
          ) {
            // TODO: it might be tricky to put this data into the table
            const parsedResults = parseRpmtestArtifactsResults(results);
            logger.debug(
              { parsedResults },
              'RPM version changes detected by parseRpmtestArtifactsResults',
            );
            setScheduleIfNoCVEs(config, parsedResults);
            addRpmtestPrBodyNotes(config, parsedResults);
            // TODO: there are other fields of interest that may need to be set, namely isVulnerabilityAlert and similar
            updateBranchConfigAfterArtifacts(config);
            logger.debug(
              { config },
              'RPM version changes detected by addRpmtestPrBodyNotes',
            );
          }
          processUpdateArtifactResults(
            results,
            updatedArtifacts,
            artifactErrors,
            artifactNotices,
          );
        }
      }
    }
  }
  return {
    reuseExistingBranch, // Need to overwrite original config
    updatedPackageFiles,
    updatedArtifacts,
    artifactErrors,
    artifactNotices,
  };
}

// workaround, see #27319
function patchConfigForArtifactsUpdate(
  config: BranchConfig,
  manager: string,
  packageFileName: string,
): UpdateArtifactsConfig {
  // drop any lockFiles that happen to be defined on the branch config
  const { lockFiles, ...updatedConfig } = config;
  if (is.nonEmptyArray(updatedConfig.packageFiles?.[manager])) {
    const managerPackageFiles: PackageFile[] =
      updatedConfig.packageFiles?.[manager];
    const packageFile = managerPackageFiles.find(
      (p) => p.packageFile === packageFileName,
    );
    if (packageFile && is.nonEmptyArray(packageFile.lockFiles)) {
      updatedConfig.lockFiles = packageFile.lockFiles;
    }
  }
  return updatedConfig;
}

async function managerUpdateArtifacts(
  manager: string,
  updateArtifact: UpdateArtifact,
): Promise<UpdateArtifactsResult[] | null> {
  const updateArtifacts = get(manager, 'updateArtifacts');
  if (updateArtifacts) {
    return await updateArtifacts(updateArtifact);
  }
  return null;
}

function processUpdateArtifactResults(
  results: UpdateArtifactsResult[] | null,
  updatedArtifacts: FileChange[],
  artifactErrors: ArtifactError[],
  artifactNotices: ArtifactNotice[],
): void {
  if (is.nonEmptyArray(results)) {
    for (const res of results) {
      const { file, notice, artifactError } = res;
      if (file) {
        updatedArtifacts.push(file);
      }

      if (artifactError) {
        artifactErrors.push(artifactError);
      }

      if (notice) {
        artifactNotices.push(notice);
      }
    }
  }
}

async function applyManagerBumpPackageVersion(
  packageFileContent: string | null,
  upgrade: BranchUpgradeConfig,
): Promise<string | null> {
  const bumpPackageVersion = get(upgrade.manager, 'bumpPackageVersion');
  if (
    !bumpPackageVersion ||
    !packageFileContent ||
    !upgrade.bumpVersion ||
    !upgrade.packageFileVersion
  ) {
    return packageFileContent;
  }

  const result = await bumpPackageVersion(
    packageFileContent,
    upgrade.packageFileVersion,
    upgrade.bumpVersion,
    upgrade.packageFile!,
  );

  return result.bumpedContent;
}

function updateBranchConfigAfterArtifacts(config: BranchConfig): void {
  //config.schedule = [];
  config.commitBody = '[SECURITY] - This update addresses a vulnerability.';
  config.prCreation = 'immediate';
  config.prHeader =
    'This PR was generated to address a detected security vulnerability.';
}

function isFileAddition(file: unknown): file is FileAddition {
  return (
    !!file && typeof file === 'object' && (file as any).type === 'addition'
  );
}

function parseRpmtestArtifactsResults(results: UpdateArtifactsResult[] | null):
  | {
      name: string;
      oldVersion: string;
      newVersion: string;
    }[]
  | null {
  if (!results) {
    return null;
  }
  const rpmRegex = /^(?<name>.+)-(?<version>[^-]+-[^-]+)\.src\.rpm$/;
  const changes = results.flatMap((res) => {
    let parsedContents = null;
    let parsedPreviousContents = null;
    const rpmVersionChanges: {
      name: string;
      oldVersion: string;
      newVersion: string;
    }[] = [];
    if (isFileAddition(res.file)) {
      try {
        if (res.file.contents) {
          parsedContents = yaml.load(res.file.contents.toString());
        }
      } catch (e) {
        parsedContents = {
          error: 'Failed to parse contents as YAML',
          details: e,
        };
      }
      try {
        if (res.file.previousContents) {
          parsedPreviousContents = yaml.load(
            res.file.previousContents.toString(),
          );
        }
      } catch (e) {
        parsedPreviousContents = {
          error: 'Failed to parse previousContents as YAML',
          details: e,
        };
      }
      // Extract sourcerpm fields from both YAMLs
      const getSourcerpms = (parsed: any): string[] => {
        if (!parsed) {
          return [];
        }
        const rpms: string[] = [];
        const search = (obj: any): void => {
          if (Array.isArray(obj)) {
            obj.forEach(search);
          } else if (obj && typeof obj === 'object') {
            for (const [key, value] of Object.entries(obj)) {
              if (key === 'sourcerpm' && typeof value === 'string') {
                rpms.push(value);
              } else {
                search(value);
              }
            }
          }
        };
        search(parsed);
        return rpms;
      };
      const newSourcerpms = getSourcerpms(parsedContents);
      const oldSourcerpms = getSourcerpms(parsedPreviousContents);
      // Map by name for easy comparison
      const parseRpm = (
        s: string,
      ): { name: string; version: string } | null => {
        const m = rpmRegex.exec(s);
        if (!m?.groups) {
          return null;
        }
        return {
          name: m.groups.name,
          version: m.groups.version,
        };
      };
      const oldMap = new Map<string, string>();
      for (const rpm of oldSourcerpms) {
        const parsed = parseRpm(rpm);
        if (parsed) {
          oldMap.set(parsed.name, parsed.version);
        }
      }
      for (const rpm of newSourcerpms) {
        const parsed = parseRpm(rpm);
        if (parsed) {
          const oldVersion = oldMap.get(parsed.name);
          if (oldVersion && oldVersion !== parsed.version) {
            rpmVersionChanges.push({
              name: parsed.name,
              oldVersion,
              newVersion: parsed.version,
            });
          }
        }
      }
    }
    return rpmVersionChanges;
  });
  return changes.length > 0 ? changes : null;
}

// this will be used for CVE information, but just for demonstration purposes
function addRpmtestPrBodyNotes(
  config: BranchConfig,
  parsedResults:
    | { name: string; oldVersion: string; newVersion: string }[]
    | null,
): void {
  if (!parsedResults || parsedResults.length === 0) {
    return;
  }
  // Assume there is always exactly one upgrade
  const upgrade = Array.isArray((config as any).upgrades)
    ? (config as any).upgrades[0]
    : undefined;
  if (!upgrade) {
    return;
  }
  if (!Array.isArray(upgrade.prBodyNotes)) {
    upgrade.prBodyNotes = [];
  }
  for (const { name, oldVersion, newVersion } of parsedResults) {
    upgrade.prBodyNotes.push(
      `RPM package "${name}" was updated from version "${oldVersion}" to "${newVersion}".`,
    );
  }
}

// this function is mean to represent finding CVEs in the DB
// If no CVEs are found, ensure that the branch is not scheduled
function setScheduleIfNoCVEs(
  config: BranchConfig,
  parsedResults:
    | { name: string; oldVersion: string; newVersion: string }[]
    | null,
): void {
  if (!parsedResults || parsedResults.length === 0) {
    return;
  }
  const hasVim = parsedResults.some(({ name }) => name === 'vim');
  // only create PR if vim is being updated... sort of a CVE simulation
  if (!hasVim) {
    config.schedule = [];
    config.isScheduledNow = false;
  }
}
