import { describe, expect, test } from "bun:test";
import { quickSort } from "./quickSort";

describe("quickSort", () => {
  test("空数组", () => expect(quickSort([])).toEqual([]));
  test("单元素", () => expect(quickSort([1])).toEqual([1]));
  test("已排序", () => expect(quickSort([1, 2, 3, 4, 5])).toEqual([1, 2, 3, 4, 5]));
  test("逆序", () => expect(quickSort([5, 4, 3, 2, 1])).toEqual([1, 2, 3, 4, 5]));
  test("重复元素", () => expect(quickSort([3, 1, 3, 2, 1, 3])).toEqual([1, 1, 2, 3, 3, 3]));
  test("随机大数组", () => {
    const arr = Array.from({ length: 10000 }, () => Math.floor(Math.random() * 1000));
    expect(quickSort(arr)).toEqual([...arr].sort((a, b) => a - b));
  });
  test("自定义比较器（字符串长度）", () => {
    const arr = ["bb", "a", "ccc", "d"];
    quickSort(arr, (a, b) => a.length - b.length);
    // 只断言按长度有序（quicksort 非稳定排序，同长度元素的相对顺序不保证）
    const lengths = arr.map(s => s.length);
    expect(lengths).toEqual([...lengths].sort((a, b) => a - b));
  });
});
