import fs from 'node:fs';
import path from 'node:path';
import { verifySha256 } from './hash.mjs';
import { resolveInside } from './paths.mjs';

export async function loadAndVerifyLicenses(repoRoot, descriptor) {
  const licenseRoot = path.join(repoRoot, 'licenses', descriptor.id);
  const files = [];
  let combined = '';
  for (const licenseFile of descriptor.license.files) {
    const filePath = resolveInside(
      licenseRoot,
      licenseFile.name,
      `license file for ${descriptor.id}`,
    );
    let data;
    try {
      data = await fs.promises.readFile(filePath);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new Error(`license file is missing: licenses/${descriptor.id}/${licenseFile.name}`);
      }
      throw error;
    }
    verifySha256(data, licenseFile.sha256, `license ${descriptor.id}/${licenseFile.name}`);
    if (data.length === 0) throw new Error(`license file is empty: ${licenseFile.name}`);
    combined += `\n${data.toString('utf8')}`;
    files.push({ ...licenseFile, data });
  }

  if (!descriptor.license.approvedForRedistribution) {
    throw new Error(`${descriptor.id} has not been approved for redistribution`);
  }
  if (!descriptor.license.reviewedBy.trim() || !descriptor.license.evidenceUrl) {
    throw new Error(`${descriptor.id} is missing manual license review evidence`);
  }

  const lower = combined.toLocaleLowerCase();
  if (descriptor.license.spdx === 'OFL-1.1' && !lower.includes('open font license')) {
    throw new Error(`${descriptor.id} declares OFL-1.1 but its license text is not OFL`);
  }
  for (const reservedName of descriptor.license.reservedFontNames) {
    if (!lower.includes(reservedName.toLocaleLowerCase())) {
      throw new Error(
        `${descriptor.id} lists reserved name ${reservedName}, but the license text does not contain it`,
      );
    }
  }
  if (descriptor.license.rfn.status === 'permission-granted') {
    const permissionText = descriptor.license.rfn.permissionText.toLocaleLowerCase();
    if (!permissionText.includes('permission') && !permissionText.includes('may')) {
      throw new Error(`${descriptor.id} RFN permission text does not describe permission`);
    }
    for (const reservedName of descriptor.license.reservedFontNames) {
      if (!permissionText.includes(reservedName.toLocaleLowerCase())) {
        throw new Error(
          `${descriptor.id} RFN permission does not explicitly cover ${reservedName}`,
        );
      }
    }
  }
  return files;
}
