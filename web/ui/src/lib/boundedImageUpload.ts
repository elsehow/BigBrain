/** Bound reading, upload and response decoding together, even if a peer hangs. */
export async function boundedImageUpload<T>(run: (signal: AbortSignal) => Promise<T>, ms = 30_000): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("Image upload timed out. Please try again.")); }, ms);
  });
  try { return await Promise.race([run(controller.signal), timeout]); }
  finally { clearTimeout(timer!); }
}
