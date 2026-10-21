// 液态玻璃工具坞的几何计算（纯函数，Node 可直接单测）。
// 公式与交互常量改编自 Sak（@Saknutella）的 Liquid Glass Slider（MIT）：
// https://github.com/Saknutella/liquid-glass-slider
// 许可见仓库根目录 THIRD-PARTY-NOTICES.md。

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

// 槽位中心换算成透镜左边缘：透镜宽度 = 一个槽位时，slot 0 的左边缘正好是 0。
export function slotPosition(slot, step, lensWidth) {
  return (slot + 0.5) * step - lensWidth / 2;
}

// 竖向导航：每个条目的上边缘 = 内边距 + 序号 ×（条目高 + 间距）。
export function navTop(index, step, padTop) {
  return padTop + index * step;
}

// 拖到两端时逐渐变「黏」，不会硬顶住；span 是允许的橡皮筋范围。
export function rubberBand(value, min, max, span) {
  if (!(span > 0)) return clamp(value, min, max);
  if (value < min) return min - span * (1 - Math.exp((value - min) / span));
  if (value > max) return max + span * (1 - Math.exp((max - value) / span));
  return value;
}

// 距 center 最近的槽位；距离相同时按拖动方向取前一个/后一个，避免相邻两格来回跳。
export function nearestSlot(slots, center, step, direction = 0) {
  return slots.reduce((best, slot) => {
    const distance = Math.abs((slot + 0.5) * step - center) - Math.abs((best + 0.5) * step - center);
    if (distance < 0) return slot;
    if (distance === 0 && (slot - best) * direction > 0) return slot;
    return best;
  });
}

// 指针横坐标落在第几个槽位（用于 hover / 拖动落点）；超出范围时返回 -1。
export function slotAt(clientX, rectLeft, padLeft, trackWidth, slotCount) {
  if (!(trackWidth > 0) || !(slotCount > 0)) return -1;
  const local = clientX - rectLeft - padLeft;
  if (local < 0 || local > trackWidth) return -1;
  return clamp(Math.floor(local / (trackWidth / slotCount)), 0, slotCount - 1);
}
