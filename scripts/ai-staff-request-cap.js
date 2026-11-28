'use strict';
// Operator-run only, in the existing backend production environment.
// No provider calls, no credentials or ledger identifiers printed.
const {connectDatabase,disconnectDatabase}=require('../src/config/database');
const {migrateStaffRequestCap}=require('../src/modules/ai/providers/funded-staff-request-cap');
async function main(){
 try{
   if(process.env.NODE_ENV!=='production'||process.env.RAILWAY_ENVIRONMENT_NAME!=='production')throw Error('Production scope required');
   await connectDatabase();
   const result=await migrateStaffRequestCap();
   console.log('AI_STAFF_REQUEST_CAP_APPLIED '+JSON.stringify(result));
 }finally{await disconnectDatabase();}
}
main().catch(()=>{console.error('AI_STAFF_REQUEST_CAP_NOT_APPLIED');process.exitCode=1;});
