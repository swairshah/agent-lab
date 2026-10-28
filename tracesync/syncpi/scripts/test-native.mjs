import { spawnSync } from 'node:child_process';
import { mkdtempSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const root=mkdtempSync(join(tmpdir(),'syncpi-native-test-'));
const live=process.env.SYNCPI_LIVE==='1';
const env={...process.env,SYNCPI_HOME:join(root,'home'),SYNCPI_RUNTIME:process.env.SYNCPI_TEST_PACKAGED==='1'?resolve('dist/SyncPi.app/Contents/Resources/runtime'):resolve('dist'),...(live?{}:{SYNCPI_FAUX:'1',PI_CODING_AGENT_DIR:join(root,'pi')})};
let status=1;
try { const run=spawnSync('cargo',['run','--manifest-path','desktop/Cargo.toml','--bin','probe'],{env,stdio:'inherit'});status=run.status??1; }
finally { const local=join(env.SYNCPI_HOME,'local');if(existsSync(local))for(const id of readdirSync(local)){try{process.kill(Number(readFileSync(join(local,id,'pid'),'utf8')),'SIGTERM');}catch{}} }
process.exit(status);
