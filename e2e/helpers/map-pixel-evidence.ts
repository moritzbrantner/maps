import { expect, type Locator, type Page, type TestInfo } from "@playwright/test";

export async function retainMapPixels(map: Locator, page: Page, info: TestInfo, name: string) {
  let verified: Buffer | undefined;
  await expect
    .poll(async () => {
      const image = await map.screenshot();
      verified = image;
      return page.evaluate(async (base64) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(image, 0, 0);
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let blue = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (
            pixels[i + 2]! > pixels[i]! + 60 &&
            pixels[i + 2]! > pixels[i + 1]! + 40 &&
            pixels[i + 3]! > 0
          )
            blue++;
        }
        return blue;
      }, image.toString("base64"));
    })
    .toBeGreaterThan(1000);
  await info.attach(name, { body: verified!, contentType: "image/png" });
}
