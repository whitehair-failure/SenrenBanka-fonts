async function writeStream(stream, text) {
  await new Promise((resolve, reject) => {
    stream.write(text, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * cn-font-split 7.4.3 can fault in its native FFI destructor after all work is
 * complete on Windows. CLI processes flush their result and exit explicitly so
 * a successful deterministic build is not masked by that teardown bug.
 */
export async function exitAfterResult(stdoutText, { code = 0, stderrText = '' } = {}) {
  if (stderrText) await writeStream(process.stderr, stderrText);
  if (stdoutText) await writeStream(process.stdout, stdoutText);
  process.exit(code);
}
