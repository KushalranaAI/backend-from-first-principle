/// <reference types="vite/client" />

declare module "virtual:course" {
  const lessons: import("./lib/parse").LessonMeta[];
  export default lessons;
}
