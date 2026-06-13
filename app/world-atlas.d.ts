// world-atlas ships TopoJSON as raw .json with no type declarations.
declare module "world-atlas/*.json" {
  const value: unknown;
  export default value;
}
