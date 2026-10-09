import {getContainer} from '@cloudflare/containers';
import {openCloudDatabase} from './data-platform/cloud-db.mjs';
import {createCloudAnalyticsBuilder,createCloudExtractors} from './cloud-extractor-client.mjs';

// DB の入口は DATABASE_ENGINE で選ぶ（d1 は R2BackedD1Database、postgres は Hyperdrive の PgDatabase に R2 の層。src/data-platform/cloud-db.mjs）。
// DB の束ね（d1 は DB、postgres は HYPERDRIVE）の確かめは openCloudDatabase がエンジンごとに行う
export function createCloudRuntime(env,ctx,options={}){if(!env.PRIVATE_ARTIFACTS||!env.WORKBENCH_CONTAINER||!env.CONTAINER_SHARED_TOKEN)throw new Error('Cloud workbench bindings are incomplete');const db=openCloudDatabase(env,ctx,options),extractors=createCloudExtractors({namespace:env.WORKBENCH_CONTAINER,getContainer,sharedToken:env.CONTAINER_SHARED_TOKEN}),containerBuild=createCloudAnalyticsBuilder({namespace:env.WORKBENCH_CONTAINER,getContainer,sharedToken:env.CONTAINER_SHARED_TOKEN});return {db,...extractors,containerBuild}}
