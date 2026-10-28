import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPreparationTabChoice } from '../public/preparation-tab-choice.js';
class Element {
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.listeners={};this.classList={add(){},toggle(){}};}
  append(...children){this.children.push(...children);}
  setAttribute(){}
  addEventListener(event,fn){this.listeners[event]=fn;}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(selector.split(',').includes(child.tagName.toLowerCase())?[child]:[]),...child.querySelectorAll(selector)]);}
}
test('UI blocks repeated views across rerenders, preserves unknown, refreshes and permits explicit recovery',async t=>{
  const previous=globalThis.document;globalThis.document={createElement:tag=>new Element(tag)};
  t.after(()=>{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;});
  let reject,resolve,calls=0,refreshes=0;const focusState={};
  const mount=()=>renderPreparationTabChoice({candidates:[{tabId:7,url:'https://chatgpt.com/'},{tabId:8,url:'https://chatgpt.com/'}],operation:'IDLE',allowed:true,focusState,
    onView:()=>{calls++;return new Promise((yes,no)=>{resolve=yes;reject=no;});},onSubmit:async()=>assert.fail('unexpected send'),onInspect:async()=>({tabId:7}),onRefresh:async()=>{refreshes++;}});
  let root=mount();const views=()=>root.querySelectorAll('button').filter(b=>b.className==='tab-choice-view');
  const first=views()[0].listeners.click();assert.ok(views().every(b=>b.disabled));
  root=mount();await views()[1].listeners.click();assert.equal(calls,1);
  reject(Object.assign(Error('timeout'),{code:'WEB_RESPONSE_TIMEOUT'}));await first;
  assert.equal(focusState.busy,false);assert.match(focusState.message,/미확인/);assert.ok(views().every(b=>b.disabled));
  root=mount();assert.match(root.querySelectorAll('p').find(p=>p.className==='tab-choice-reason').textContent,/이미 이동/);
  await root.querySelectorAll('button').find(b=>b.textContent==='최신 상태 조회').listeners.click();
  assert.equal(refreshes,1);assert.equal(calls,1);assert.ok(views().every(b=>!b.disabled));
  const next=views()[1].listeners.click();resolve({opened:true,tabId:8});await next;
  assert.equal(calls,2);assert.equal(focusState.busy,false);assert.ok(views().every(b=>!b.disabled));assert.match(focusState.message,/열었습니다/);
});
