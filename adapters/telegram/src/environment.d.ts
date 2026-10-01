// mtcute's declarations name Deno's file type behind `AnyToNever`, meaning
// "absent on runtimes without Deno". On Bun it is absent, so it is `never`.
declare namespace Deno {
  type FsFile = never;
}
