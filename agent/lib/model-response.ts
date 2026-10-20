/** Public failure messages emitted after eve exhausts empty-response attempts. */
export function isEmptyModelResponse(message: string | undefined): boolean {
  return (
    message?.includes("EmptyModelResponseError") === true ||
    message?.includes("The model did not return a response") === true
  );
}
