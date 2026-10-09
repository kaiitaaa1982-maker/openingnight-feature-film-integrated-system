import {Container} from '@cloudflare/containers';

export class WorkbenchExtractContainer extends Container {
  constructor(ctx,env){super(ctx,env);this.bindingEnv=env;this.envVars={CLOUD_ANALYTICS_REGISTRATION_ID:env.CLOUD_ANALYTICS_REGISTRATION_ID,CLOUD_ANALYTICS_DEFINITION_VERSION:env.CLOUD_ANALYTICS_DEFINITION_VERSION,CLOUD_ANALYTICS_NODE:'/usr/local/bin/node'}}
  defaultPort=8080;
  requiredPorts=[8080];
  sleepAfter='2m';
  enableInternet=false;
  pingEndpoint='localhost/ready';
  async fetch(request){const url=new URL(request.url);if(!['/extract','/analytics/build'].includes(url.pathname)||request.method!=='POST')return new Response('Not found',{status:404});const expected=this.bindingEnv?.CONTAINER_SHARED_TOKEN;if(!expected||request.headers.get('x-openingnight-container-token')!==expected)return new Response('Forbidden',{status:403});return this.containerFetch(new Request(`http://localhost:8080${url.pathname}`,{method:'POST',headers:{'content-type':'application/json'},body:request.body}))}
}
