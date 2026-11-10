import { isDeepStrictEqual } from 'node:util';

// Diagnostic assertions for existing Node tests, not a separate execution engine.
// Each level consumes the EXACT output of the preceding level.
// A level is PASS only after checking at least one independent expected/actual field.
export async function runProgressiveIO(t, {feature, input, levels, depth = levels?.length}) {
  if (!feature || !Array.isArray(levels) || levels.length === 0 || levels.length > 10
    || !Number.isInteger(depth) || depth < 1 || depth > levels.length
    || levels.some(x => !x || !x.name || typeof x.process !== 'function'
      || typeof x.observe !== 'function' || !x.expected || Object.keys(x.expected).length === 0)) {
    throw new TypeError('PROGRESSIVE_IO_CONFIG_INVALID: 1..10 observable levels and valid depth are required');
  }
  const records = [];
  let current = input;
  const emit = entry => {
    const record = {feature, ...entry};
    records.push(record);
    t.diagnostic(`IO_DEPTH ${JSON.stringify(record)}`);
  };
  async function visit(index, value) {
    if (index === levels.length) return value;
    const level = levels[index];
    const number = index + 1;
    if (number > depth) {
      for (let later = index; later < levels.length; later++) {
        emit({depth:later+1, node:levels[later].name, status:'DEFERRED', reason:`selected depth=${depth}`});
      }
      return value;
    }
    let output, actual, inputActual, failure;
    const expectsInput = Object.hasOwn(level, 'expectedInput');
    try {
      if (expectsInput) {
        if (typeof level.observeInput !== 'function') throw new Error('expectedInput requires observeInput');
        inputActual = await level.observeInput(value);
        if (!isDeepStrictEqual(inputActual, level.expectedInput)) {
          const wrong = Object.entries(level.expectedInput)
            .filter(([key, expected]) => !isDeepStrictEqual(inputActual?.[key], expected))
            .map(([key, expected]) => ({field:`input.${key}`,expected,actual:inputActual?.[key]}));
          emit({depth:number,node:level.name,status:'FAIL',boundary:'INPUT',
            differences:wrong,expected:level.expectedInput,actual:inputActual});
          for (let later=index+1;later<levels.length;later++) {
            emit({depth:later+1,node:levels[later].name,status:'NOT_RUN',blockedBy:number});
          }
          throw Object.assign(new Error(`IO_DEPTH_FAILED ${feature} > ${number} ${level.name} input: ${JSON.stringify(wrong)}`),
            {ioBoundaryFailure:true});
        }
      }
      // process() is invoked exactly once. Its output is the child node's input.
      output = await level.process(value);
      actual = await level.observe(output, value);
      if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
        throw new Error('observe() must return a record of actual field values');
      }
    } catch (error) { if (error.ioBoundaryFailure) throw error; failure = error; }
    const differences = failure ? [] : Object.entries(level.expected)
      .filter(([field, expected]) => !isDeepStrictEqual(actual[field], expected))
      .map(([field, expected]) => ({field, expected, actual:actual[field]}));
    if (failure || differences.length) {
      emit({depth:number, node:level.name, status:'FAIL',
        ...(failure ? {reason:failure.message} : {}),
        differences, expected:level.expected, actual:actual ?? null});
      for (let later = index + 1; later < levels.length; later++) {
        emit({depth:later+1, node:levels[later].name, status:'NOT_RUN', blockedBy:number});
      }
      const mismatch = differences.map(x => `${x.field}: expected=${JSON.stringify(x.expected)}, actual=${JSON.stringify(x.actual)}`).join('; ');
      throw new Error(`IO_DEPTH_FAILED ${feature} > ${number} ${level.name}: ${mismatch || failure.message}`, {cause:failure});
    }
    emit({depth:number, node:level.name, status:'PASS',
      ...(expectsInput ? {input:{expected:level.expectedInput,actual:inputActual}} : {}),
      output:{expected:level.expected,actual}});
    return visit(index+1, output);
  }
  current = await visit(0, current);
  emit({status:depth === levels.length ? 'COMPLETE' : 'PARTIAL', depth, total:levels.length});
  return {output:current, records};
}
