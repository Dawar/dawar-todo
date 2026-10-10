import type {SourceWriterBinding} from './source-writer-admission.mjs';
export type SourceInstallationLineage = {version:1;kind:'dawar-original-installation-lineage';original:SourceWriterBinding;deployedBuild:string};
export function sourceInstallationBinding(input:{expected:unknown;build:string;lineage?:string}):SourceWriterBinding;
