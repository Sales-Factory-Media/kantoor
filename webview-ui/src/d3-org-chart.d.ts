declare module 'd3-org-chart' {
  export class OrgChart {
    container(el: string | HTMLElement): this
    data(data: unknown[]): this
    nodeWidth(fn: (d: unknown) => number): this
    nodeHeight(fn: (d: unknown) => number): this
    childrenMargin(fn: (d: unknown) => number): this
    siblingsMargin(fn: (d: unknown) => number): this
    neighbourMargin(fn: (d1: unknown, d2: unknown) => number): this
    compactMarginBetween(fn: (d: unknown) => number): this
    compactMarginPair(fn: (d: unknown) => number): this
    nodeContent(fn: (d: unknown) => string): this
    onNodeClick(fn: (d: unknown) => void): this
    nodeButtonHeight(fn: (d: unknown) => number): this
    nodeButtonWidth(fn: (d: unknown) => number): this
    nodeButtonX(fn: (d: unknown) => number): this
    nodeButtonY(fn: (d: unknown) => number): this
    linkUpdate(fn: (this: SVGPathElement, d: unknown, i: number, arr: unknown[]) => void): this
    initialExpandLevel(level: number): this
    compact(val: boolean): this
    render(): this
    fit(): this
  }
}
