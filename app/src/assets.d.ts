declare module "*.png" {
  const src: string;
  export default src;
}

declare module "*.svg?url" {
  const src: string;
  export default src;
}

declare module "*.svg?no-inline" {
  const src: string;
  export default src;
}
