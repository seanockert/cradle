// SVG files load as text (see rules in wrangler.jsonc)
declare module '*.svg' {
  const svg: string
  export default svg
}
