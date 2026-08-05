/** 快速排序（原地，Lomuto 分区） */

export function quickSort<T>(
  arr: T[],
  compare: (a: T, b: T) => number = ((a: unknown, b: unknown) => (a as number) - (b as number)) as (a: T, b: T) => number,
): T[] {
  sort(arr, 0, arr.length - 1, compare);
  return arr;
}

function sort<T>(arr: T[], lo: number, hi: number, compare: (a: T, b: T) => number): void {
  if (lo >= hi) return;
  const p = partition(arr, lo, hi, compare);
  sort(arr, lo, p - 1, compare);
  sort(arr, p + 1, hi, compare);
}

function partition<T>(arr: T[], lo: number, hi: number, compare: (a: T, b: T) => number): number {
  const pivot = arr[hi];
  let i = lo;
  for (let j = lo; j < hi; j++) {
    if (compare(arr[j], pivot) < 0) {
      [arr[i], arr[j]] = [arr[j], arr[i]];
      i++;
    }
  }
  [arr[i], arr[hi]] = [arr[hi], arr[i]];
  return i;
}
