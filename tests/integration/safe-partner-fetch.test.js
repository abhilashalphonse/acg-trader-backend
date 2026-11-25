'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {publicIPv4,validatePartnerUrl,safePartnerFetch}=require('../../src/modules/integration/safe-partner-fetch');
const {buildTenantWebhookRoutes}=require('../../src/modules/integration/tenant-webhook-routes');

test('partner egress rejects literal and private destinations and special IPv4 ranges',()=>{
  for(const host of ['https://127.0.0.1/h','https://2130706433/h','https://169.254.169.254/h','https://localhost/h','https://db.railway.internal/h','https://a.local/h','https://[::1]/h','https://example.test:444/h','https://u:p@example.test/h','http://example.test/h']) assert.throws(()=>validatePartnerUrl(host));
  for(const ip of ['0.0.0.0','10.1.2.3','100.64.0.1','127.0.0.1','169.254.169.254','172.16.2.2','192.168.1.1','192.0.2.1','198.18.1.1','198.51.100.2','203.0.113.1','224.0.0.1','::ffff:127.0.0.1']) assert.equal(publicIPv4(ip),false,ip);
  assert.equal(publicIPv4('8.8.8.8'),true);
  assert.equal(validatePartnerUrl('https://partner.example.test/h').protocol,'https:');
});
test('partner egress rejects mixed DNS answers before opening any connection',async()=>{
  let requests=0;
  await assert.rejects(safePartnerFetch('https://partner.example.test/h',{},{lookup:async()=>[{family:4,address:'8.8.8.8'},{family:4,address:'127.0.0.1'}],request(){requests++;}}),/prohibited/);
  assert.equal(requests,0);
});
test('partner egress pins validated DNS address and never follows a redirect',async()=>{
  const {EventEmitter}=require('node:events');
  let count=0;
  const response=await safePartnerFetch('https://partner.example.test/h',{headers:{},body:'{}'},{lookup:async()=>[{family:4,address:'8.8.8.8'}],request(url,options,callback){
    count++;assert.equal(url.hostname,'partner.example.test');assert.equal(options.agent,false);
    options.lookup(url.hostname,{all:false},(error,ip,family)=>{assert.ifError(error);assert.equal(ip,'8.8.8.8');assert.equal(family,4);});
    const req=new EventEmitter();req.end=()=>{const res=new EventEmitter();res.statusCode=302;res.destroy=()=>{};callback(res);};return req;
  }});
  assert.equal(count,1);assert.equal(response.ok,false);
});
test('generic partner routes need no Funded credentials and validate subscriptions',()=>{
  const route={tenantId:'64a000000000000000000002',url:'https://partner.example.test/h',secret:'independent-fixture-secret',keyId:'v2',eventTypes:['DEAL_CREATED']};
  const map=buildTenantWebhookRoutes({enabled:true,partnerRoutes:[route]});
  assert.deepEqual(map.get(route.tenantId).eventTypes,['DEAL_CREATED']);assert.equal(map.get(route.tenantId).keyId,'v2');
  assert.throws(()=>buildTenantWebhookRoutes({enabled:true,partnerRoutes:[{...route,eventTypes:['UNKNOWN']}]}),/subscriptions/);
  assert.throws(()=>buildTenantWebhookRoutes({enabled:true,partnerRoutes:[{...route,url:'https://db.railway.internal/'}]}),/public HTTPS/);
});
