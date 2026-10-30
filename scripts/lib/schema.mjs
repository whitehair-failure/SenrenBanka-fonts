import { z } from 'zod';
import { SHA256_PATTERN } from './hash.mjs';
import { assertSafeFileName, assertSafeRelativePath } from './paths.mjs';

const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WEIGHT = /^(?:100|200|300|400|500|600|700|800|900)(?: (?:100|200|300|400|500|600|700|800|900))?$/;
const STRETCH = /^(?:\d{1,3}(?:\.\d+)?%|\d{1,3}(?:\.\d+)?% \d{1,3}(?:\.\d+)?%)$/;
const UNICODE_RANGE_TOKEN = /^U\+[0-9A-F?]{1,6}(?:-[0-9A-F]{1,6})?$/;
const CSS_VAR = /^--[a-z0-9-]+$/;
const SAFE_PATH = /^(?!.*(?:^|\/)\.\.?(?:\/|$))(?!.*\\)(?!\/).+$/;

const sha256Schema = z.string().regex(SHA256_PATTERN, 'must be a lowercase SHA-256 digest');
const idSchema = z.string().regex(ID, 'must be a lowercase kebab-case id');
const versionSchema = z.string().regex(SEMVER, 'must be a semantic version');
const dateSchema = z.string().regex(DATE, 'must use YYYY-MM-DD');
const relativePathSchema = z
  .string()
  .max(240)
  .regex(SAFE_PATH, 'must be a safe relative POSIX path')
  .refine(
    (value) => {
      try {
        assertSafeRelativePath(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'must be a safe relative POSIX path' },
  );
const fileNameSchema = z
  .string()
  .max(200)
  .refine(
    (value) => {
      try {
        assertSafeFileName(value);
        return true;
      } catch {
        return false;
      }
    },
    { message: 'must be a safe file name' },
  );
const httpsUrlSchema = z
  .string()
  .url()
  .refine((value) => new URL(value).protocol === 'https:', 'must use HTTPS');

const sourceDownloadSchema = z
  .object({
    url: httpsUrlSchema,
    sha256: sha256Schema,
    archiveMember: relativePathSchema.optional(),
  })
  .strict();

const sourceFileSchema = z
  .object({
    fileName: fileNameSchema,
    size: z.number().int().positive().max(512 * 1024 * 1024),
    sha256: sha256Schema,
    bootstrapKey: relativePathSchema,
    download: sourceDownloadSchema.optional(),
  })
  .strict();

const sourceSchema = z
  .object({
    project: z.string().min(1),
    version: z.string().min(1),
    url: httpsUrlSchema,
    revision: z.string().min(1).optional(),
    retrievedAt: dateSchema,
    files: z.array(sourceFileSchema).min(1),
  })
  .strict();

const licenseFileSchema = z
  .object({
    name: fileNameSchema,
    sha256: sha256Schema,
  })
  .strict();

const rfnSchema = z
  .object({
    status: z.enum([
      'not-applicable',
      'unmodified-distribution',
      'permission-granted',
      'renamed',
    ]),
    basis: z.string().min(1),
    permissionEvidenceUrl: httpsUrlSchema.optional(),
    permissionText: z.string().min(1).optional(),
  })
  .strict();

const licenseSchema = z
  .object({
    spdx: z.enum(['OFL-1.1', 'Apache-2.0', 'CC0-1.0']),
    approvedForRedistribution: z.literal(true),
    reviewedAt: dateSchema,
    reviewedBy: z.string().min(1),
    evidenceUrl: httpsUrlSchema,
    files: z.array(licenseFileSchema).min(1),
    reservedFontNames: z.array(z.string().min(1)),
    rfn: rfnSchema,
  })
  .strict();

const fixedVariantSchema = z
  .object({
    sourceFile: fileNameSchema.refine(
      (value) => /\.woff2$/i.test(value),
      'must be a WOFF2 source file',
    ),
    file: fileNameSchema.refine(
      (value) => /\.woff2$/i.test(value),
      'must be a WOFF2 output file',
    ),
    weight: z.string().regex(WEIGHT),
    style: z.enum(['normal', 'italic', 'oblique']),
    stretch: z.string().regex(STRETCH).optional(),
    display: z.enum(['auto', 'block', 'swap', 'fallback', 'optional']),
    unicodeRange: z.array(z.string().regex(UNICODE_RANGE_TOKEN)).min(1).optional(),
    features: z.array(z.string().min(1)).optional(),
    variationSettings: z.record(z.string(), z.number()).optional(),
  })
  .strict();

const fixedOutputSchema = z
  .object({
    type: z.literal('fixed'),
    variants: z.array(fixedVariantSchema).min(1),
  })
  .strict();

const coreOutputSchema = z
  .object({
    type: z.literal('core-cjk'),
    sourceFile: fileNameSchema.refine(
      (value) => /\.(?:ttf|otf)$/i.test(value),
      'must be an uncompressed TTF/OTF source file',
    ),
    weight: z.string().regex(WEIGHT),
    style: z.enum(['normal', 'italic', 'oblique']),
    display: z.enum(['auto', 'block', 'swap', 'fallback', 'optional']),
    chunkSize: z.number().int().min(256).max(256 * 1024),
    languageAreas: z.literal(true),
    fontFeature: z.literal(true),
    rename: z.object({ to: z.string().min(1) }).strict().optional(),
  })
  .strict();

const outputSchema = z.discriminatedUnion('type', [fixedOutputSchema, coreOutputSchema]);

const provenanceSchema = z
  .object({
    retrievedAt: dateSchema,
    processing: z.string().min(1),
    notes: z.string().min(1),
  })
  .strict();

export const familyDescriptorSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: idSchema,
    familyName: z.string().min(1),
    sourceFamilyName: z.string().min(1),
    role: z.enum(['fixed', 'core-cjk']),
    version: versionSchema,
    source: sourceSchema,
    license: licenseSchema,
    output: outputSchema,
    cssVariable: z.string().regex(CSS_VAR),
    fallbacks: z.array(z.string().min(1)).min(1),
    provenance: provenanceSchema,
  })
  .strict()
  .superRefine((descriptor, context) => {
    const sourceNames = new Set();
    for (const file of descriptor.source.files) {
      if (sourceNames.has(file.fileName)) {
        context.addIssue({
          code: 'custom',
          path: ['source', 'files'],
          message: `duplicate source file ${file.fileName}`,
        });
      }
      sourceNames.add(file.fileName);
    }

    const licenseNames = new Set();
    for (const file of descriptor.license.files) {
      if (licenseNames.has(file.name)) {
        context.addIssue({
          code: 'custom',
          path: ['license', 'files'],
          message: `duplicate license file ${file.name}`,
        });
      }
      licenseNames.add(file.name);
    }

    if (descriptor.role === 'core-cjk' && descriptor.output.type !== 'core-cjk') {
      context.addIssue({
        code: 'custom',
        path: ['output', 'type'],
        message: 'core-cjk role requires core-cjk output',
      });
    }
    if (descriptor.role === 'fixed' && descriptor.output.type !== 'fixed') {
      context.addIssue({
        code: 'custom',
        path: ['output', 'type'],
        message: 'fixed role requires fixed output',
      });
    }

    const outputNames = new Set();
    if (descriptor.output.type === 'fixed') {
      for (const variant of descriptor.output.variants) {
        if (!sourceNames.has(variant.sourceFile)) {
          context.addIssue({
            code: 'custom',
            path: ['output', 'variants'],
            message: `variant references unknown source file ${variant.sourceFile}`,
          });
        }
        if (outputNames.has(variant.file)) {
          context.addIssue({
            code: 'custom',
            path: ['output', 'variants'],
            message: `duplicate output font ${variant.file}`,
          });
        }
        outputNames.add(variant.file);
      }
    } else if (!sourceNames.has(descriptor.output.sourceFile)) {
      context.addIssue({
        code: 'custom',
        path: ['output', 'sourceFile'],
        message: `core output references unknown source file ${descriptor.output.sourceFile}`,
      });
    }

    const hasRfn = descriptor.license.reservedFontNames.length > 0;
    if (!hasRfn && descriptor.license.rfn.status !== 'not-applicable') {
      context.addIssue({
        code: 'custom',
        path: ['license', 'rfn', 'status'],
        message: 'a font without reserved names must use rfn.status=not-applicable',
      });
    }
    if (hasRfn && descriptor.license.rfn.status === 'not-applicable') {
      context.addIssue({
        code: 'custom',
        path: ['license', 'rfn', 'status'],
        message: 'reserved font names require an explicit RFN strategy',
      });
    }
    if (
      hasRfn &&
      descriptor.output.type === 'core-cjk' &&
      !['permission-granted', 'renamed'].includes(descriptor.license.rfn.status)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['license', 'rfn', 'status'],
        message: 'modified core-cjk output needs RFN permission or a rename',
      });
    }
    if (
      descriptor.license.rfn.status === 'permission-granted' &&
      (!descriptor.license.rfn.permissionEvidenceUrl ||
        !descriptor.license.rfn.permissionText)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['license', 'rfn'],
        message: 'permission-granted RFN requires evidence URL and permission text',
      });
    }
    if (descriptor.license.rfn.status === 'renamed') {
      if (descriptor.output.type !== 'core-cjk' || !descriptor.output.rename) {
        context.addIssue({
          code: 'custom',
          path: ['output', 'rename'],
          message: 'renamed RFN requires core-cjk output.rename',
        });
      } else {
        const replacement = descriptor.output.rename.to.toLowerCase();
        const collision = descriptor.license.reservedFontNames.find((name) =>
          replacement.includes(name.toLowerCase()),
        );
        if (collision) {
          context.addIssue({
            code: 'custom',
            path: ['output', 'rename', 'to'],
            message: `replacement name still contains reserved name ${collision}`,
          });
        }
      }
    }
  });

const fontMetadataSchema = z
  .object({
    familyName: z.string().min(1),
    subfamilyName: z.string().min(1),
    postscriptName: z.string().min(1),
    format: z.enum(['TTF', 'OTF', 'WOFF', 'WOFF2']),
    weight: z.number().int(),
    widthClass: z.number().int(),
    italicAngle: z.number(),
    coverageCount: z.number().int().nonnegative(),
    variationAxes: z.record(
      z.string(),
      z
        .object({
          min: z.number(),
          default: z.number(),
          max: z.number(),
        })
        .strict(),
    ),
  })
  .strict();

const manifestVariantSchema = z
  .object({
    file: relativePathSchema
      .startsWith('fonts/')
      .refine((value) => /\.woff2$/i.test(value), 'must be a WOFF2 output file'),
    sha256: sha256Schema,
    size: z.number().int().positive(),
    weight: z.string().regex(WEIGHT),
    style: z.enum(['normal', 'italic', 'oblique']),
    stretch: z.string().regex(STRETCH).optional(),
    display: z.enum(['auto', 'block', 'swap', 'fallback', 'optional']),
    unicodeRange: z.array(z.string().regex(UNICODE_RANGE_TOKEN)).min(1).optional(),
    cmapAliases: z.array(z.number().int().min(0).max(0x10ffff)).optional(),
    features: z.array(z.string().min(1)).optional(),
    variationSettings: z.record(z.string(), z.number()).optional(),
    font: fontMetadataSchema,
  })
  .strict();

export const familyManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('family'),
    id: idSchema,
    familyName: z.string().min(1),
    sourceFamilyName: z.string().min(1),
    role: z.enum(['fixed', 'core-cjk']),
    version: versionSchema,
    cssVariable: z.string().regex(CSS_VAR),
    fallbacks: z.array(z.string().min(1)).min(1),
    buildTools: z
      .object({
        cnFontSplit: z.string().min(1),
        fontkitten: z.string().min(1),
        schema: z.literal(1),
      })
      .strict(),
    source: z
      .object({
        archiveFileName: fileNameSchema,
        files: z
          .array(
            z
              .object({
                fileName: fileNameSchema,
                sha256: sha256Schema,
                size: z.number().int().positive(),
              })
              .strict(),
          )
          .min(1),
      })
      .strict(),
    license: z
      .object({
        spdx: z.enum(['OFL-1.1', 'Apache-2.0', 'CC0-1.0']),
        approvedForRedistribution: z.literal(true),
        reviewedAt: dateSchema,
        reviewedBy: z.string().min(1),
        evidenceUrl: httpsUrlSchema,
        files: z
          .array(
            z
              .object({
                file: relativePathSchema.startsWith('licenses/'),
                sha256: sha256Schema,
                size: z.number().int().positive(),
              })
              .strict(),
          )
          .min(1),
        reservedFontNames: z.array(z.string().min(1)),
        rfn: rfnSchema,
      })
      .strict(),
    css: z.literal('font.css'),
    variants: z.array(manifestVariantSchema).min(1),
  })
  .strict()
  .superRefine((manifest, context) => {
    const declared = new Set();
    for (const variant of manifest.variants) {
      if (declared.has(variant.file)) {
        context.addIssue({
          code: 'custom',
          path: ['variants'],
          message: `duplicate manifest font ${variant.file}`,
        });
      }
      declared.add(variant.file);
    }
  });

export const sourceManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal('source'),
    id: idSchema,
    version: versionSchema,
    upstream: z
      .object({
        project: z.string().min(1),
        version: z.string().min(1),
        url: httpsUrlSchema,
        revision: z.string().min(1).optional(),
        retrievedAt: dateSchema,
      })
      .strict(),
    files: z
      .array(
        z
          .object({
            file: relativePathSchema.startsWith('source/fonts/'),
            sha256: sha256Schema,
            size: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1),
    licenses: z
      .array(
        z
          .object({
            file: relativePathSchema.startsWith('source/licenses/'),
            sha256: sha256Schema,
            size: z.number().int().positive(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

const releaseAssetSchema = z
  .object({
    releaseTag: z
      .string()
      .regex(
        /^[a-z][a-z0-9-]*-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
      ),
    fileName: fileNameSchema,
    sha256: sha256Schema,
    size: z.number().int().positive(),
  })
  .strict();

const catalogFamilySchema = z
  .object({
    version: versionSchema,
    role: z.enum(['fixed', 'core-cjk']),
    package: releaseAssetSchema,
    source: releaseAssetSchema,
  })
  .strict();

export const catalogSchema = z
  .object({
    schemaVersion: z.literal(1),
    catalogVersion: versionSchema,
    baseUrl: httpsUrlSchema.refine((value) => !value.endsWith('/'), 'must not end with /'),
    families: z.record(idSchema, catalogFamilySchema),
  })
  .strict()
  .superRefine((catalog, context) => {
    for (const [id, family] of Object.entries(catalog.families)) {
      const expectedPackageTag = `font-${id}-v${family.version}`;
      if (family.package.releaseTag !== expectedPackageTag) {
        context.addIssue({
          code: 'custom',
          path: ['families', id, 'package', 'releaseTag'],
          message: `package release tag must be ${expectedPackageTag}`,
        });
      }
      if (family.source.releaseTag !== expectedPackageTag) {
        context.addIssue({
          code: 'custom',
          path: ['families', id, 'source', 'releaseTag'],
          message: `source release tag must be ${expectedPackageTag}`,
        });
      }
      if (family.package.fileName !== `${id}-v${family.version}.tar.gz`) {
        context.addIssue({
          code: 'custom',
          path: ['families', id, 'package', 'fileName'],
          message: 'unexpected package file name',
        });
      }
      if (family.source.fileName !== `${id}-v${family.version}-source.tar.gz`) {
        context.addIssue({
          code: 'custom',
          path: ['families', id, 'source', 'fileName'],
          message: 'unexpected source file name',
        });
      }
    }
  });

function formatIssues(error) {
  return error.issues
    .map((issue) => `${issue.path.length ? issue.path.join('.') : '<root>'}: ${issue.message}`)
    .join('; ');
}

export function parseWithSchema(schema, value, label) {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${label} is invalid: ${formatIssues(result.error)}`);
  return result.data;
}

export function parseFamilyDescriptor(value, label = 'family descriptor') {
  return parseWithSchema(familyDescriptorSchema, value, label);
}

export function parseFamilyManifest(value, label = 'family manifest') {
  return parseWithSchema(familyManifestSchema, value, label);
}

export function parseSourceManifest(value, label = 'source manifest') {
  return parseWithSchema(sourceManifestSchema, value, label);
}

export function parseCatalog(value, label = 'catalog') {
  return parseWithSchema(catalogSchema, value, label);
}

export const schemas = {
  'family.schema.json': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://github.com/whitehair-failure/SenrenBanka-fonts/schemas/family.schema.json',
    title: 'SenrenBanka font family descriptor v1',
    ...z.toJSONSchema(familyDescriptorSchema, { io: 'input', target: 'draft-2020-12' }),
  },
  'catalog.schema.json': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://github.com/whitehair-failure/SenrenBanka-fonts/schemas/catalog.schema.json',
    title: 'SenrenBanka font catalog v1',
    ...z.toJSONSchema(catalogSchema, { io: 'input', target: 'draft-2020-12' }),
  },
  'manifest.schema.json': {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://github.com/whitehair-failure/SenrenBanka-fonts/schemas/manifest.schema.json',
    title: 'SenrenBanka family and source manifest v1',
    anyOf: [
      z.toJSONSchema(familyManifestSchema, { io: 'input', target: 'draft-2020-12' }),
      z.toJSONSchema(sourceManifestSchema, { io: 'input', target: 'draft-2020-12' }),
    ],
  },
};
