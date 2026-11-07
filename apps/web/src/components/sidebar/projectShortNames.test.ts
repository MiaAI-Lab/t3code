import { describe, expect, it } from "vite-plus/test";

import { shortProjectNames } from "./projectShortNames";

describe("shortProjectNames", () => {
  it("keeps what tells long, similar names apart and leaves the rest whole", () => {
    const spark = "GLM-5.3-Flash-EXL3-2x-DGX-Spark-TensorFold-Zig";
    const rtx = "GLM-5.3-Flash-EXL3-2x-RTX-PRO-6000-TensorFold-Zig";
    const names = shortProjectNames([spark, rtx, spark, "sparkDash", "ScreenDiv"]);
    expect(names.get(spark)).toBe("GLM…DGX-Spark");
    expect(names.get(rtx)).toBe("GLM…RTX-PRO-6000");
    expect(names.has("sparkDash")).toBe(false);
  });

  it("leaves a long name alone when nothing similar sits beside it", () => {
    expect(shortProjectNames(["GLM-5.3-Flash-EXL3-2x-DGX-Spark-TensorFold-Zig"]).size).toBe(0);
    // Sharing only a first word is too little to drop.
    expect(
      shortProjectNames(["web-dashboard-for-the-cluster-admin", "web-crawler-with-a-long-name"])
        .size,
    ).toBe(0);
  });
});
