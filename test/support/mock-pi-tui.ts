// SPDX-License-Identifier: Apache-2.0
/**
 * Minimal mock for @mariozechner/pi-tui used by index.ts.
 * Intercepts the import so tests don't need the real pi-tui package.
 */
export class Box {
  constructor(_width: number, _height: number, _themeFn?: Function) {}
  addChild(_child: unknown) {}
}
export class Text {
  constructor(_content: string, _x: number, _y: number) {}
}
export class Markdown {
  constructor(_content: string) {}
}
export default { Box, Text, Markdown };