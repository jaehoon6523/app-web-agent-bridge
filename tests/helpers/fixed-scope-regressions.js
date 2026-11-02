import test from 'node:test';
import assert from 'node:assert/strict';

export function registerFixedScopeTests({dashboard, stateFor}) {
  test('fixed scope 1: initial mismatched response blocks commands and retains the state error', async () => {
    const state = stateFor({runId:'A',version:3,phase:'WORKER_RUNNING',objective:'A'}, ['run.stop']);
    state.run = {...state.run,runId:'B'};
    const ui = await dashboard(state);
    assert.equal(ui.run('connected'),false);
    assert.equal(ui.run('connectionState.lastError.code'),'DASHBOARD_STATE_INVALID');
    await ui.run('command("run.stop")');
    assert.equal(ui.calls.filter(x=>x.url==='/api/commands').length,0);
  });

  test('fixed scope 2: late failure belongs to A after switching to B', async () => {
    const state = stateFor({runId:'A',version:3,phase:'HOLD',objective:'A'},['run.stop']);
    let reject;
    const pending = new Promise((_resolve, fail)=>{reject=fail;});
    const ui = await dashboard(state,async()=>pending);
    const sent = ui.run('command("run.stop")');
    Object.assign(state,stateFor({runId:'B',version:8,phase:'HOLD',objective:'B'},['run.stop']));
    ui.run('openRun("B")'); await ui.run('refresh()');
    reject(Object.assign(new Error('late failure'),{code:'RUN_BUSY'}));
    await sent;
    assert.equal(ui.run('selected'),'B');
    assert.equal(ui.elements.get('commandResult').textContent,'');
    assert.equal(ui.run('lastCommandResult.runId'),'A');
    assert.equal(ui.run('lastCommandResult.requestId'),'request-1');
    ui.run('openRun("A")');
    Object.assign(state,stateFor({runId:'A',version:3,phase:'HOLD',objective:'A'},['run.stop']));
    await ui.run('refresh()');
    assert.ok(ui.elements.get('commandResult').textContent.length>0);
  });

  test('fixed scope 2: late delete success cannot replace B selection', async () => {
    const state=stateFor({runId:'A',version:3,phase:'APPLIED',objective:'A'},['run.delete']);
    let resolve;
    const pending=new Promise(done=>{resolve=done;});
    const ui=await dashboard(state,async()=>pending);
    const sent=ui.run('command("run.delete")');
    Object.assign(state,stateFor({runId:'B',version:8,phase:'APPLIED',objective:'B'},[]));
    ui.run('openRun("B")');await ui.run('refresh()');
    resolve({payload:{status:'DELETED'}});await sent;
    assert.equal(ui.run('selected'),'B');
    assert.equal(ui.elements.get('runPanel').dataset.runId,'B');
  });

  for (const returnToA of [false,true]) {
    test(`fixed scope 2: late note keeps same-text input after view change (returnToA=${returnToA})`,async()=>{
      const a={runId:'A',version:3,phase:'HOLD',objective:'A'};
      const state=stateFor(a,['run.note.add']);
      let resolve;
      const pending=new Promise(done=>{resolve=done;});
      const ui=await dashboard(state,async()=>pending);
      ui.elements.get('operatorNoteText').value='same input';await ui.run('render()');
      const sent=ui.elements.get('addOperatorNote').listeners.click();
      Object.assign(state,stateFor({runId:'B',version:8,phase:'HOLD',objective:'B'},['run.note.add']));
      ui.run('openRun("B")');await ui.run('refresh()');
      if(returnToA){Object.assign(state,stateFor(a,['run.note.add']));ui.run('openRun("A")');await ui.run('refresh()');}
      ui.elements.get('operatorNoteText').value='same input';
      resolve({payload:{status:'RECORDED'}});await sent;
      assert.equal(ui.elements.get('operatorNoteText').value,'same input');
    });
  }

  test('fixed scope 2: background refresh in the same view does not discard a successful note',async()=>{
    const state=stateFor({runId:'A',version:3,phase:'HOLD',objective:'A'},['run.note.add']);
    let resolve;
    const pending=new Promise(done=>{resolve=done;});
    const ui=await dashboard(state,async()=>pending);
    ui.elements.get('operatorNoteText').value='same input';await ui.run('render()');
    const sent=ui.elements.get('addOperatorNote').listeners.click();
    await ui.run('refresh()');
    resolve({payload:{status:'RECORDED'}});await sent;
    assert.equal(ui.elements.get('operatorNoteText').value,'');
  });
}
