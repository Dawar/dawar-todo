/** Preserve MCP-compatible content through code-mode nested tool returns.
 * Native inputImage did not survive that path as an image block and exceeded
 * its IPC bound in the observed failure. Keep base64 as a string until the
 * caller explicitly forwards the image, as with the existing desktop tools.
 */
export function nativeToolResult(result) {
  const value = result?.__secureModelContent ? { content: result.__secureModelContent } : result;
  return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(value) }] };
}
