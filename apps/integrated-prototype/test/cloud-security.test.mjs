import test from 'node:test';
import assert from 'node:assert/strict';
import {cloudConfig,isSafeCloudRequest} from '../src/cloud-security.mjs';

const env={DEPLOYMENT_ENABLED:'true',ACCESS_TEAM_DOMAIN:'example-team.cloudflareaccess.com',ACCESS_AUD:'aud',PUBLIC_ORIGIN:'https://app.example.invalid',DB:{},ASSETS:{},PRIVATE_ARTIFACTS:{},WORKBENCH_CONTAINER:{},CONTAINER_SHARED_TOKEN:'secret',CLOUD_ANALYTICS_REGISTRATION_ID:'synthetic-1',CLOUD_ANALYTICS_DEFINITION_VERSION:'cloud-1'};
test('cloud config fails closed without exact HTTPS public origin',()=>{assert.equal(cloudConfig({...env,PUBLIC_ORIGIN:'http://app.example.invalid'}),null);assert.equal(cloudConfig({...env,PRIVATE_ARTIFACTS:null}),null);assert.equal(cloudConfig(env).publicOrigin,env.PUBLIC_ORIGIN)});
test('state changes require the exact same origin',()=>{const cfg=cloudConfig(env);assert.equal(isSafeCloudRequest(new Request(`${env.PUBLIC_ORIGIN}/api/x`,{method:'POST',headers:{Origin:env.PUBLIC_ORIGIN,'Sec-Fetch-Site':'same-origin'}}),cfg),true);assert.equal(isSafeCloudRequest(new Request(`${env.PUBLIC_ORIGIN}/api/x`,{method:'POST',headers:{Origin:'https://evil.example'}}),cfg),false);assert.equal(isSafeCloudRequest(new Request('https://preview.example/api/x'),cfg),false)});
