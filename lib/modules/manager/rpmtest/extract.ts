import { logger } from '../../../logger';
import { getSiblingFileName } from '../../../util/fs';
import type { PackageFileContent } from '../types';

export async function extractPackageFile(
  content: string,
  packageFile: string,
): Promise<PackageFileContent | null> {
  logger.debug(`rpm.extractPackageFile(${packageFile})`);

  const extension = packageFile.split('.').pop();
  const lockFile = getSiblingFileName(packageFile, `rpms.lock.${extension}`);

  logger.debug(`RPM lock file: ${lockFile}`);

  await Promise.resolve();

  return {
    lockFiles: [lockFile],
    deps: [],
  };
}
