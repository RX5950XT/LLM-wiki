/**
 * True when a key press belongs to the input method rather than the app: Enter here picks a
 * Chinese candidate, and must not send, save, or jump. Safari reports `isComposing: false` on
 * that Enter, so keyCode 229 has to be checked as well.
 */
export function isImeKey(event: { nativeEvent: { isComposing: boolean }; keyCode: number }): boolean {
  return event.nativeEvent.isComposing || event.keyCode === 229;
}
