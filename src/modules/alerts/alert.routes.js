'use strict';
const express = require('express');
const mongoose = require('mongoose');
const { z } = require('zod');
const { requireTraderSession } = require('../auth/auth.middleware');
const { profileIdentity } = require('../profile/trader-profile.service');
const { AppError } = require('../../shared/errors/app-error');
const { streamIdFor } = require('./alert-event-contract');
const { ticks } = require('./alert-evaluator');
const { AlertRule, AlertTrigger, AlertReplayGap, StreamCoverage, AlertLease, AlertSubscription, AlertOutbox } = require('./alert-models');

const price = z.string().regex(/^\d{1,12}(\.\d{1,10})?$/).refine(v => Number(v) > 0, 'Price must be positive');
const definitionSchema = z.object({
  symbol: z.string().regex(/^[A-Z0-9._-]{1,30}$/), name: z.string().trim().max(80).default(''),
  note: z.string().trim().max(300).default(''),
  condition: z.discriminatedUnion('type', [
    ...['crosses','crosses_above','crosses_below','candle_close_above','candle_close_below'].map(type => z.object({ type: z.literal(type), level: price }).strict()),
    ...['enters_range','exits_range'].map(type => z.object({ type: z.literal(type), lower: price, upper: price }).strict()),
  ]),
  priceSource: z.enum(['bid','ask','last']).default('last'),
  timeframe: z.enum(['1m','5m','15m','30m','1h','4h','1d']).nullable().default(null),
  frequency: z.enum(['once','repeat']).default('once'), cooldownMs: z.number().int().min(0).max(86400000).default(60000),
  expiresAt: z.iso.datetime().nullable().default(null), pushEnabled: z.boolean().default(false), soundEnabled: z.boolean().default(true),
}).strict();
const createSchema = definitionSchema.extend({ clientRequestId: z.uuid() });
const editSchema = definitionSchema.extend({ version: z.number().int().positive() });

function identity(principal) {
  const id = profileIdentity(principal);
  return { tenantId: id.tenantId, ownerId: id.principalKey };
}
function parse(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) throw new AppError('Check the alert settings', { statusCode: 400, code: 'INVALID_ALERT' });
  return result.data;
}
function idFilter(req) {
  if (!/^[a-f0-9]{24}$/i.test(req.params.id)) throw new AppError('Alert not found', { statusCode: 404 });
  return { _id: req.params.id, ...identity(req.traderPrincipal), deleted: false };
}
function validateDefinition(data, runtime) {
  const instrument = runtime.instrumentRegistry.get(data.symbol);
  if (!instrument || !instrument.chartEnabled || instrument.status !== 'ACTIVE' || !instrument.tickSize) {
    throw new AppError('This instrument is not available for alerts', { statusCode: 400 });
  }
  const tickSize = String(instrument.tickSize);
  if (data.condition.lower && BigInt(ticks(data.condition.lower,tickSize)) >= BigInt(ticks(data.condition.upper,tickSize))) {
    throw new AppError('The upper price must exceed the lower price', { statusCode: 400 });
  }
  if (data.condition.type.startsWith('candle_') && (data.priceSource !== 'last' || !data.timeframe || !runtime.timeframes.includes(data.timeframe))) {
    throw new AppError('Choose a supported candle timeframe and Last price', { statusCode: 400 });
  }
  if (data.expiresAt && Date.parse(data.expiresAt) <= Date.now()) throw new AppError('Expiry must be in the future', { statusCode: 400 });
  return { ...data, tickSize, feedId: instrument.provider, streamId: streamIdFor(instrument.provider,data.symbol) };
}
function publicRule(r, coverage, evaluatorLease) {
  const lastEvent = coverage?.lastEventAt ? new Date(coverage.lastEventAt).getTime() : 0;
  let monitoring = r.runtime?.monitoring || 'STARTING';
  if (['STARTING','MONITORING'].includes(r.status) && (!coverage || coverage.status !== 'MONITORING' || Date.now()-lastEvent>30000)) monitoring = 'WAITING_FOR_DATA';
  else if (['STARTING','MONITORING'].includes(r.status) && (!evaluatorLease || new Date(evaluatorLease.expiresAt).getTime()<=Date.now() ||
    r.runtime?.lastObservedMs && Date.now()-Number(r.runtime.lastObservedMs)>30000)) monitoring='RECOVERING';
  return { id: String(r._id), version: r.version, name:r.name, note:r.note, symbol:r.symbol,
    condition:r.condition, priceSource:r.priceSource, timeframe:r.timeframe, frequency:r.frequency,
    cooldownMs:r.cooldownMs, expiresAt:r.expiresAt, pushEnabled:r.pushEnabled, soundEnabled:r.soundEnabled!==false,
    status:r.status, monitoring, createdAt:r.createdAt };
}
function createAlertRouter({ authService, marketRuntime }) {
  const router = express.Router();
  router.use(requireTraderSession(authService));
  router.use((_req,res,next)=>{res.setHeader('Cache-Control','no-store');next();});
  router.get('/config', (_req,res)=>res.json({ enabled:true, maxAlerts:100,
    pushPublicKey:process.env.ACG_ALERTS_VAPID_PUBLIC_KEY || null }));
  router.get('/', async(req,res)=>{
    const rows=await AlertRule.find({...identity(req.traderPrincipal),deleted:false}).sort({_id:-1}).limit(100).lean();
    const coverage=await StreamCoverage.find({_id:{$in:[...new Set(rows.map(r=>r.streamId))]}}).lean();
    const lease=await AlertLease.findById('stage2-alert-evaluator').lean();
    res.json({alerts:rows.map(r=>publicRule(r,coverage.find(c=>c._id===r.streamId),lease))});
  });
  router.post('/', async(req,res)=>{
    const data=validateDefinition(parse(createSchema,req.body),marketRuntime);
    const owner=identity(req.traderPrincipal);
    const existing=await AlertRule.findOne({...owner,clientRequestId:data.clientRequestId}).lean();
    if(existing) return res.json({alert:publicRule(existing)});
    const guardId='alert-quota:'+JSON.stringify(owner);
    await AlertLease.updateOne({_id:guardId},{$setOnInsert:{ownerId:owner.ownerId,token:0,expiresAt:new Date(0)}},{upsert:true});
    const session=await mongoose.startSession(); let record;
    try {
      await session.withTransaction(async()=>{
        await AlertLease.updateOne({_id:guardId},{$inc:{token:1}},{session});
        const repeated=await AlertRule.findOne({...owner,clientRequestId:data.clientRequestId}).session(session);
        if(repeated){record=repeated;return;}
        if(await AlertRule.countDocuments({...owner,deleted:false}).session(session)>=100) throw new AppError('Maximum 100 saved alerts. Remove an alert to continue.',{statusCode:409});
        [record]=await AlertRule.create([{...data,...owner,status:'STARTING',version:1,effectiveFrom:new Date(),runtime:null,checkpoint:null}],{session});
      },{readConcern:{level:'snapshot'},writeConcern:{w:'majority'}});
    } finally {await session.endSession();}
    res.status(201).json({alert:publicRule(record)});
  });
  router.put('/:id',async(req,res)=>{
    const {version,...body}=parse(editSchema,req.body);
    const data=validateDefinition(body,marketRuntime);
    const result=await AlertRule.findOneAndUpdate({...idFilter(req),version},{$set:{...data,status:'STARTING',runtime:null,checkpoint:null,effectiveFrom:new Date()},$inc:{version:1}},{new:true});
    if(!result) throw new AppError('Alert changed. Refresh and try again.',{statusCode:409});
    res.json({alert:publicRule(result)});
  });
  router.patch('/:id/status',async(req,res)=>{
    const {version,status}=parse(z.object({version:z.number().int().positive(),status:z.enum(['PAUSED','STARTING'])}).strict(),req.body);
    const result=await AlertRule.findOneAndUpdate({...idFilter(req),version},{$set:{status,runtime:null,checkpoint:null,effectiveFrom:new Date()},$inc:{version:1}},{new:true});
    if(!result) throw new AppError('Alert changed. Refresh and try again.',{statusCode:409});
    res.json({alert:publicRule(result)});
  });
  router.delete('/:id',async(req,res)=>{
    const {version}=parse(z.object({version:z.number().int().positive()}).strict(),req.body);
    const result=await AlertRule.updateOne({...idFilter(req),version},{$set:{deleted:true,status:'PAUSED'},$inc:{version:1}});
    if(result.matchedCount!==1) throw new AppError('Alert changed. Refresh and try again.',{statusCode:409});
    res.status(204).end();
  });
  router.get('/history',async(req,res)=>{
    const owner=identity(req.traderPrincipal);
    const before=typeof req.query.before==='string'&&/^[a-f0-9]{24}$/i.test(req.query.before)?{_id:{$lt:req.query.before}}:{};
    const events=await AlertTrigger.find({...owner,...before}).sort({_id:-1}).limit(50).lean();
    const deliveries=await AlertOutbox.find({triggerId:{$in:events.map(e=>e._id)},channel:'push'}).lean();
    const gaps=await AlertReplayGap.find(owner).sort({_id:-1}).limit(20).lean();
    res.json({events:events.map(e=>({id:String(e._id),alertId:String(e.alertId),createdAt:e.createdAt,readAt:e.readAt,evidence:e.evidence,pushStatus:deliveries.find(d=>String(d.triggerId)===String(e._id))?.status||null})),gaps:gaps.map(g=>({id:String(g._id),reason:g.reason,streamId:g.streamId,createdAt:g.createdAt})),nextBefore:events.length===50?String(events.at(-1)._id):null});
  });
  router.post('/history/read',async(req,res)=>{
    const {ids}=parse(z.object({ids:z.array(z.string().regex(/^[a-f0-9]{24}$/i)).max(50)}).strict(),req.body);
    await AlertTrigger.updateMany({...identity(req.traderPrincipal),_id:{$in:ids},readAt:null},{$set:{readAt:new Date()}});
    res.status(204).end();
  });
  const subscriptionSchema=z.object({endpoint:z.url().max(2048),keys:z.object({p256dh:z.string().min(40).max(200),auth:z.string().min(10).max(100)}).strict()}).strict();
  router.post('/push',async(req,res)=>{
    if(!process.env.ACG_ALERTS_VAPID_PUBLIC_KEY)throw new AppError('Push notifications are unavailable',{statusCode:503});
    const body=parse(subscriptionSchema,req.body);
    // Only known push services may be contacted; never permit arbitrary URLs/SSRF.
    const url=new URL(body.endpoint);
    if(url.protocol!=='https:'||url.port||url.username||url.password||!['fcm.googleapis.com','updates.push.services.mozilla.com','web.push.apple.com','wns2-par02p.notify.windows.com'].includes(url.hostname)) throw new AppError('Unsupported push service',{statusCode:400});
    const owner=identity(req.traderPrincipal);
    if(await AlertSubscription.countDocuments(owner)>=10&&!await AlertSubscription.exists({...owner,endpoint:body.endpoint}))throw new AppError('Maximum 10 devices',{statusCode:409});
    await AlertSubscription.findOneAndUpdate({endpoint:body.endpoint},{$set:{...body,...owner}},{upsert:true});
    res.status(204).end();
  });
  router.post('/push/remove',async(req,res)=>{
    const {endpoint}=parse(z.object({endpoint:z.string().max(2048)}).strict(),req.body);
    await AlertSubscription.deleteOne({...identity(req.traderPrincipal),endpoint});res.status(204).end();
  });
  return router;
}
module.exports={createAlertRouter,definitionSchema,identity,validateDefinition,publicRule};
