/** Optimistic-concurrency failure: someone else changed the record first.
 * Kept apart from the repository so services that raise it do not have to
 * import the repository module and create a cycle. */
export class Conflict extends Error {}
