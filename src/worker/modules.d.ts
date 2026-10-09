/** Binary assets bundled as ArrayBuffer by the `Data` rule in wrangler.toml. */
declare module '*.png' {
  const data: ArrayBuffer;
  export default data;
}
