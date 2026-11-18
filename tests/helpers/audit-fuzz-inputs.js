const GENERATOR_VERSION = "audit-reality-v2";
const DEFAULT_SEED = 0x5eedc0de;
const DEFAULT_DOMAIN_CASES = 200;
const DEFAULT_FLOW_CASES = 12;
const DOMAIN_SALTS = Object.freeze({
  "evidence-binding": 0x00000001,
  "prompt-literal": 0x000a11ce,
  "pipeline": 0x00c0ffee,
});

function integerEnv(name, fallback, max, allowZero = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  const minimum = allowZero ? 0 : 1;
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > max) throw new TypeError(`${name} must be ${minimum}..${max}`);
  return parsed;
}
function seedEnv() {
  return integerEnv("AUDIT_FUZZ_SEED", DEFAULT_SEED, 0xffff_ffff, true);
}
function targetCaseEnv() {
  const value = process.env.AUDIT_FUZZ_CASE;
  return value === undefined || value === "" ? null : integerEnv("AUDIT_FUZZ_CASE", 0, 4999, true);
}
function targetDomainEnv() {
  const value = process.env.AUDIT_FUZZ_DOMAIN;
  if (value === undefined || value === "") return null;
  if (!Object.hasOwn(DOMAIN_SALTS, value)) {
    throw new TypeError(`AUDIT_FUZZ_DOMAIN must be one of: ${Object.keys(DOMAIN_SALTS).join(", ")}`);
  }
  return value;
}
function mix32(value) {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}
function caseSeed(seed, index, salt = 0) {
  return mix32((seed >>> 0) ^ Math.imul((index + 1) >>> 0, 0x9e3779b1) ^ (salt >>> 0));
}
function random(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17; state >>>= 0;
    state ^= state << 5; state >>>= 0;
    return state;
  };
}
function choose(rng, values) { return values[rng() % values.length]; }
function shuffle(rng, values) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = rng() % (index + 1);
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}
function subset(rng, values) {
  const selected = values.filter(() => (rng() & 1) === 1);
  return selected.length ? selected : [choose(rng, values)];
}
function caseIndexes(name, fallback, max, target) {
  if (target !== null) return [target];
  const count = integerEnv(name, fallback, max);
  return Array.from({ length:count }, (_, index) => index);
}
function enabledDomain(domain, targetDomain) {
  return targetDomain === null || targetDomain === domain;
}
function descriptor(seed, index, domain, mutation, details = {}) {
  const salt = DOMAIN_SALTS[domain];
  return {
    generatorVersion:GENERATOR_VERSION,
    scenarioId:`${GENERATOR_VERSION}:${domain}:${seed}:${index}`,
    seed,
    case:index,
    domain,
    caseSeed:caseSeed(seed, index, salt),
    mutation,
    replay:{
      AUDIT_FUZZ_DOMAIN:domain,
      AUDIT_FUZZ_SEED:String(seed),
      AUDIT_FUZZ_CASE:String(index),
    },
    ...details,
  };
}
function failureContext(value) {
  return `AUDIT_REALITY_FAILURE ${JSON.stringify(value)}`;
}

export { GENERATOR_VERSION, DEFAULT_DOMAIN_CASES, DEFAULT_FLOW_CASES, DOMAIN_SALTS, seedEnv, targetCaseEnv, targetDomainEnv, caseSeed,
  random, choose, shuffle, subset, caseIndexes, enabledDomain, descriptor, failureContext };
