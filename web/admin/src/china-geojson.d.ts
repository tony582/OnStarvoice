declare module 'china-geojson/src/geojson/china.json' {
  const data: {
    type: string
    features: Array<{
      type: string
      properties: { name: string; id?: string; cp?: number[] }
      geometry: unknown
    }>
  }
  export default data
}
