const MAX_DETAILS = 100;
const MAX_BYTES = 1024 * 1024;
const limits = {name:512, file:2048, message:4096, code:256, stack:8192};

export function failureDetail(data) {
  const detail = {name:null, file:null, line:null, column:null, testId:null,
    collectionStatus:'COLLECTED', error:null, truncated:[]};
  const read = (value, key) => {
    try { return value?.[key]; }
    catch { detail.collectionStatus = 'ERROR'; return undefined; }
  };
  const text = (value, key, location) => {
    if (value == null) return null;
    if (!['string','number','boolean','bigint'].includes(typeof value)) {
      detail.collectionStatus = 'ERROR'; return null;
    }
    const string = String(value);
    if (string.length > limits[key]) detail.truncated.push(location);
    return string.slice(0, limits[key]);
  };
  for (const key of ['name','file']) detail[key] = text(read(data,key),key,key);
  for (const key of ['line','column']) {
    const value = read(data,key);
    detail[key] = Number.isSafeInteger(value) && value >= 0 ? value : null;
  }
  const seen = new Set();
  const errorRecord = (value, depth) => {
    if (value == null) return null;
    const record = {name:null, message:null, code:null, stack:null, cause:null};
    if (!['object','function'].includes(typeof value)) {
      record.message = text(value,'message',`error.${depth}.message`);
      return record;
    }
    if (seen.has(value)) { detail.truncated.push('causeCycle'); return null; }
    seen.add(value);
    for (const key of ['name','message','code','stack']) {
      record[key] = text(read(value,key),key,`error.${depth}.${key}`);
    }
    const cause = read(value,'cause');
    if (cause != null) {
      if (depth === 4) detail.truncated.push('causeDepth');
      else record.cause = errorRecord(cause, depth+1);
    }
    return record;
  };
  detail.error = errorRecord(read(read(data,'details'),'error'),0);
  return detail;
}

export function failureCollector(summary) {
  Object.assign(summary, {failedDetailsSchemaVersion:1, failedDetails:[],
    failedDetailsOmitted:0, failedDetailsTruncated:false});
  let bytes = 2;
  return data => {
    // Count only events actually observed; never infer missing records afterward.
    summary.failed++;
    if (summary.failedDetails.length === MAX_DETAILS) {
      summary.failedDetailsOmitted++; summary.failedDetailsTruncated = true; return;
    }
    const detail = failureDetail(data);
    const size = Buffer.byteLength(JSON.stringify(detail),'utf8') + (summary.failedDetails.length ? 1 : 0);
    if (bytes + size > MAX_BYTES) {
      summary.failedDetailsOmitted++; summary.failedDetailsTruncated = true; return;
    }
    summary.failedDetails.push(detail); bytes += size;
  };
}

// Live runs require this version. Historical readers need not call this validator.
export function failureDetailsIntegrity(summary) {
  if (summary?.failedDetailsSchemaVersion !== 1 || !Number.isSafeInteger(summary.failed) || summary.failed < 0
    || !Array.isArray(summary.failedDetails) || summary.failedDetails.length > MAX_DETAILS
    || !Number.isSafeInteger(summary.failedDetailsOmitted) || summary.failedDetailsOmitted < 0
    || summary.failed !== summary.failedDetails.length + summary.failedDetailsOmitted
    || summary.failedDetailsTruncated !== (summary.failedDetailsOmitted > 0)
    || Buffer.byteLength(JSON.stringify(summary.failedDetails),'utf8') > MAX_BYTES) return 'INVALID';
  const validText = (value,key) => value === null || typeof value === 'string' && value.length <= limits[key];
  const validError = (value,depth=0) => value === null || depth <= 4 && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === 'cause,code,message,name,stack'
    && ['name','message','code','stack'].every(key => validText(value[key],key)) && validError(value.cause,depth+1);
  for (const detail of summary.failedDetails) {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)
      || !['COLLECTED','ERROR'].includes(detail.collectionStatus) || detail.testId !== null
      || !['name','file'].every(key => validText(detail[key],key))
      || !['line','column'].every(key => detail[key] === null || Number.isSafeInteger(detail[key]) && detail[key] >= 0)
      || !Array.isArray(detail.truncated) || detail.truncated.length > 24
      || !detail.truncated.every(value => typeof value === 'string' && value.length <= 64)
      || !validError(detail.error)) return 'INVALID';
  }
  return summary.failedDetails.some(detail => detail.collectionStatus === 'ERROR') ? 'PARTIAL' : 'OK';
}
