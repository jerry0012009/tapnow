export function messageListener<Sender>(
  types: readonly string[],
  handle: (message: any, sender: Sender) => unknown | Promise<unknown>
) {
  return (message: any, sender: Sender, sendResponse: (value: any) => void): boolean => {
    if (!types.includes(message?.type)) return false;
    // Ignore unrelated messages synchronously; never race another listener with null.
    Promise.resolve().then(() => handle(message, sender)).then(sendResponse, error => {
      sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
    });
    return true;
  };
}
