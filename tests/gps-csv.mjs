import test from 'node:test';
import assert from 'node:assert/strict';
import {parseGpsCsv} from '../web/src/gpsCsv.ts';
const header='observed_at_utc,received_at_utc,latitude,longitude,accuracy_m,source,samples,system_vpn\n';
test('CSV restore keeps original uncertainty and rejects invalid rows before importing',()=>{
 const row='2026-01-01T00:00:00Z,2026-01-01T00:00:01Z,33,-80,800,passive,1,\r\n';
 assert.equal(parseGpsCsv(header+row)[0].accuracy,800);
 assert.equal(parseGpsCsv(header+row)[0].system_vpn,null);
 assert.throws(()=>parseGpsCsv(header+row.replace(',33,',',91,')),/row 2/);
 assert.throws(()=>parseGpsCsv(header+row.replace(',800,',',,')),/row 2/);
 assert.throws(()=>parseGpsCsv('network,data'),/CSV/);
});
