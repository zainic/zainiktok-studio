import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createStore} from '../db.js';
import {tokenCrypto} from '../tiktok.js';

test('SQLite data survives close and reopen',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'zainiktok-db-'));
  try {
    let store=createStore(dir);
    store.setSetting('timezone','Asia/Jakarta');
    store.run('INSERT INTO videos(id,name,filename,mime,size,source,created_at) VALUES(?,?,?,?,?,?,?)','v1','sample.mp4','/tmp/sample.mp4','video/mp4',123,'upload',100);
    store.db.close();
    store=createStore(dir);
    assert.equal(store.getSetting('timezone'),'Asia/Jakarta');
    assert.equal(store.one('SELECT name FROM videos WHERE id=?','v1').name,'sample.mp4');
    store.db.close();
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test('OAuth token encryption roundtrips and wrong key fails',()=>{
  const a=tokenCrypto('a'.repeat(64)),b=tokenCrypto('b'.repeat(64));
  const blob=a.encrypt({access_token:'secret',refresh_token:'rotates'});
  assert.deepEqual(a.decrypt(blob),{access_token:'secret',refresh_token:'rotates'});
  assert.throws(()=>b.decrypt(blob));
  assert.equal(tokenCrypto('invalid'),null);
});
