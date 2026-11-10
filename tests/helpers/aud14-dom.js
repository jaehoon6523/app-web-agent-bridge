// Minimal DOM fixture: identity/containment is real object topology, not preset proof booleans.
export class Element {
  constructor(tagName = "DIV", attrs = {}, text = "") { this.tagName=tagName; this.attrs=attrs; this.text=text; this.children=[]; this.parentElement=null; }
  append(...children) { for(const child of children) { child.parentElement=this; this.children.push(child); } return this; }
  getAttribute(key) { return this.attrs[key] ?? null; }
  get classList() { return {contains:name=>(this.attrs.class??"").split(/\s+/u).includes(name)}; }
  get className() { return this.attrs.class??""; }
  get textContent() { return this.text+this.children.map(n=>n.textContent).join(""); }
  get innerText() { return this.textContent; }
  contains(other) { return this===other || this.children.some(n=>n.contains(other)); }
  matches(selector) { return selector.split(",").some(s=>{ s=s.trim();
    if(s==="h4.sr-only") return this.tagName==="H4" && this.classList.contains("sr-only");
    if(s===".markdown") return this.classList.contains("markdown");
    if(s.startsWith("article")) { if(this.tagName!=="ARTICLE")return false;s=s.slice(7); }
    const m=s.match(/^\[([^=\]^]+)(\^?=)?(?:['"]?([^'"\]]*)['"]?)?\]$/u);
    if(!m)return false;const value=this.getAttribute(m[1]);return value!==null && (!m[2] || (m[2]==="^="?value.startsWith(m[3]):value===m[3]));
  }); }
  querySelectorAll(selector) { return this.children.flatMap(n=>[...(n.matches(selector)?[n]:[]),...n.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0]??null; }
  closest(selector) { for(let n=this;n;n=n.parentElement)if(n.matches(selector))return n;return null; }
}
export function fixtureMessage(role,text,{heading=true,search=false,explicit=true,id="m1"}={}) {
  const attrs={...(explicit?{"data-message-author-role":role}:{}),...(search?{"data-chatgpt-search-unit-key":`turn:${role}`,"data-chatgpt-search-message-ids":id}:{}),"data-message-id":id};
  const node=new Element("DIV",attrs), content=new Element("DIV",{"data-message-content":"",...(role==="user"?{"data-markdown-text-tone":"user-message"}:{"data-markdown-text-style":"assistant-message"})},text);
  node.append(content);const parent=new Element();const title=new Element("H4",{class:"sr-only"},role==="user"?"You said:":"ChatGPT said:");
  if(heading)parent.append(title);parent.append(node);return {node,content,parent,title};
}
