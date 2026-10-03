export async function bounded(promise, milliseconds = 10000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('E2E operation exceeded external deadline')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
