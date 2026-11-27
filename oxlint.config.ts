import oxlintBaseConfig from '@willbooster/oxlint-config';
import type { OxlintConfig } from 'oxlint';

const oxlintResolvedConfig: OxlintConfig = structuredClone(oxlintBaseConfig);
delete oxlintResolvedConfig.options;

export default oxlintResolvedConfig;
