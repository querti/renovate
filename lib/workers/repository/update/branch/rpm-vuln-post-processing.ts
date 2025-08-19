import is from '@sindresorhus/is';
import { logger } from '../../../../logger';
import { RedHatRPMLockfile } from '../../../../modules/manager/rpm/schema';
import type {
  PackageDependency,
  UpdateArtifactsResult,
} from '../../../../modules/manager/types';
import * as p from '../../../../util/promises';
import { parseSingleYaml } from '../../../../util/yaml';
import type { BranchConfig } from '../../../types';
import { RpmVulnerabilities } from '../../process/rpm-vulnerabilities';
import type {
  DependencyVulnerabilities,
  Vulnerability,
} from '../../process/types';

export async function postProcessRPMVulnerabilities(
  result: UpdateArtifactsResult[] | null,
  config: BranchConfig,
): Promise<UpdateArtifactsResult[] | null> {
  logger.debug('RPM vulnerability post-processing');
  if (result === null) {
    logger.debug('No RPM updates have been proposed');
    return result;
  }

  const packages = parseLockfilePackages(result);
  logger.debug(JSON.stringify(packages, null, 2));
  if (packages.length === 0) {
    logger.warn('No RPM packages could be parsed');
    return result;
  }

  const rpmVulnerabilities = await RpmVulnerabilities.create();
  const vulnerabilities = await createVulnerabilities(
    packages,
    rpmVulnerabilities,
  );
  logger.debug(`Found ${vulnerabilities.length} vulnerabilities`);

  if (vulnerabilities.length === 0) {
    logger.debug('No RPM vulnerabilities found');
    return null;
  }

  applyVulnerabilityPRNotes(vulnerabilities, config, rpmVulnerabilities);

  return result;
}

export function parseLockfilePackages(
  results: UpdateArtifactsResult[],
): PackageDependency[] {
  const packages: PackageDependency[] = [];
  for (const result of results) {
    if (result?.file?.type !== 'addition') {
      continue;
    }
    const oldLockFileContent = result.file.previousContents;
    const newLockFileContent = result.file.contents;

    if (
      typeof oldLockFileContent === 'string' &&
      typeof newLockFileContent === 'string'
    ) {
      try {
        const oldLockFile = parseSingleYaml(oldLockFileContent, {
          customSchema: RedHatRPMLockfile,
        });
        const newLockFile = parseSingleYaml(newLockFileContent, {
          customSchema: RedHatRPMLockfile,
        });
        for (const arch of oldLockFile.arches) {
          const archDeps: PackageDependency[] = arch.packages.map(
            (dependency) => ({
              depName: dependency.name,
              packageName: dependency.name,
              currentValue: dependency.evr,
              currentVersion: dependency.evr,
              versioning: 'rpm',
              datasource: 'rpm-lockfile',
            }),
          );
          for (const dep of archDeps) {
            if (packages.findIndex((d) => d.depName === dep.depName) === -1) {
              packages.push(dep);
            }
          }
        }

        const newLockfilePkgMap = new Map<string, string>();
        for (const arch of newLockFile.arches) {
          for (const pkg of arch.packages) {
            newLockfilePkgMap.set(pkg.name, pkg.evr);
          }
        }
        for (const pkg of packages) {
          const newEvr = newLockfilePkgMap.get(
            pkg.depName ?? pkg.packageName ?? '',
          );
          if (newEvr) {
            pkg.newValue = newEvr;
            pkg.newVersion = newEvr;
          } else {
            // if the package is not found in the new lockfile then mark it as such
            pkg.enabled = false;
          }
        }
      } catch {
        logger.debug(`Error parsing lockfile: ${result.file.path}`);
      }
    }
  }
  const changedPackages = packages.filter(
    (pkg) => pkg.currentVersion !== pkg.newVersion || !pkg.newVersion,
  );
  return changedPackages;
}

export async function createVulnerabilities(
  packages: PackageDependency[],
  rpmVulns: RpmVulnerabilities,
): Promise<Vulnerability[]> {
  const dummyPackageFileConfig = {
    packageFile: 'dummy.spec',
    deps: [],
    manager: 'rpm-lockfile',
    datasource: 'rpm-lockfile',
  };

  const queue = packages.map(
    (pkg) => (): Promise<DependencyVulnerabilities | null> =>
      rpmVulns.fetchDependencyVulnerability(dummyPackageFileConfig, pkg, true),
  );

  const results = await p.all(queue);
  const filteredResults = results.filter(is.truthy);
  const allVulnerabilities = filteredResults.flatMap(
    (result) => result.vulnerabilities,
  );
  const uniqueVulnerabilities = Array.from(
    new Map(
      allVulnerabilities.map((vuln) => [vuln.vulnerability.id, vuln]),
    ).values(),
  );

  return uniqueVulnerabilities;
}

export function applyVulnerabilityPRNotes(
  vulnerabilities: Vulnerability[],
  config: BranchConfig,
  rpmVulns: RpmVulnerabilities,
): void {
  // this function is called multiple times for each lockfile in a PR, so we don't know
  // the final number of vulnerabilities in each isolated run. This can create a side
  // effect where first few vulnerabilities will have a description but the rest won't.

  const truncated =
    vulnerabilities.length + (config.upgrades[0].prBodyNotes?.length ?? 0) > 10;
  const prBodyNotesList: string[] = [];

  for (const vulnerability of vulnerabilities) {
    const prBodyNotes = rpmVulns.generatePrBodyNotes(
      vulnerability.vulnerability,
      vulnerability.affected,
      truncated,
      false,
    );

    prBodyNotesList.push(...prBodyNotes);
  }

  config.prBodyNotes = [...(config.prBodyNotes ?? []), ...prBodyNotesList];
  config.upgrades[0].prBodyNotes = [
    ...(config.upgrades[0].prBodyNotes ?? []),
    ...prBodyNotesList,
  ];

  //TODO: logic for filtering vulnerabilities is definitely needed: what if new vuln is
  // added to nedb and no relevant update is proposed in the PR? It would still be affected!
  // TODO: the script assumes that there can be only one RPM with same name. This is wrong. It needs
  // to be able to handle multiple RPMs with possible different version updates
}
