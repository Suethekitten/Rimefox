// 液态玻璃位移滤镜：位移贴图 + RGB 三通道色散，不是简单的 blur。
// 直接复用并改编自 Sak（@Saknutella）的 Liquid Glass Slider（MIT）：
// https://github.com/Saknutella/liquid-glass-slider
// 其中位移贴图与三通道色散算法改编自 nikdelvin/liquid-glass（MIT，© 2025 Nikita Stadnik）。
// 两段版权与许可全文见仓库根目录 THIRD-PARTY-NOTICES.md；分发时请保留。

function displacementMap(options) {
  const height = options.height;
  const width = options.width;
  const radius = options.radius;
  const depth = options.depth;
  const y1 = Math.ceil((radius / height) * 15);
  const y2 = Math.floor(100 - (radius / height) * 15);
  const x1 = Math.ceil((radius / width) * 15);
  const x2 = Math.floor(100 - (radius / width) * 15);
  const svg =
    '<svg height="' + height + '" width="' + width + '" viewBox="0 0 ' + width + ' ' + height + '" xmlns="http://www.w3.org/2000/svg">' +
    '<style>.mix { mix-blend-mode: screen; }</style>' +
    '<defs>' +
    '<linearGradient id="Y" x1="0" x2="0" y1="' + y1 + '%" y2="' + y2 + '%">' +
    '<stop offset="0%" stop-color="#0F0" /><stop offset="100%" stop-color="#000" />' +
    '</linearGradient>' +
    '<linearGradient id="X" x1="' + x1 + '%" x2="' + x2 + '%" y1="0" y2="0">' +
    '<stop offset="0%" stop-color="#F00" /><stop offset="100%" stop-color="#000" />' +
    '</linearGradient>' +
    '</defs>' +
    '<rect x="0" y="0" height="' + height + '" width="' + width + '" fill="#808080" />' +
    '<g filter="blur(2px)">' +
    '<rect x="0" y="0" height="' + height + '" width="' + width + '" fill="#000080" />' +
    '<rect x="0" y="0" height="' + height + '" width="' + width + '" fill="url(#Y)" class="mix" />' +
    '<rect x="0" y="0" height="' + height + '" width="' + width + '" fill="url(#X)" class="mix" />' +
    '<rect x="' + depth + '" y="' + depth + '" height="' + (height - 2 * depth) + '" width="' + (width - 2 * depth) + '" fill="#808080" rx="' + radius + '" ry="' + radius + '" filter="blur(' + depth + 'px)" />' +
    '</g></svg>';
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
}

// 生成一段内联 SVG 滤镜（data URL + fragment id）。
// 三通道位移量：R = strength + 2×cab，G = strength + 1×cab，B = strength。
export function displacementFilter(options) {
  const height = options.height;
  const width = options.width;
  const radius = options.radius;
  const depth = options.depth;
  const strength = options.strength == null ? 100 : options.strength;
  const cab = options.chromaticAberration == null ? 0 : options.chromaticAberration;
  const map = displacementMap({ height: height, width: width, radius: radius, depth: depth });
  const svg =
    '<svg height="' + height + '" width="' + width + '" viewBox="0 0 ' + width + ' ' + height + '" xmlns="http://www.w3.org/2000/svg">' +
    '<defs>' +
    '<filter id="displace" color-interpolation-filters="sRGB">' +
    '<feImage x="0" y="0" height="' + height + '" width="' + width + '" href="' + map + '" result="displacementMap" />' +
    '<feDisplacementMap transform-origin="center" in="SourceGraphic" in2="displacementMap" scale="' + (strength + cab * 2) + '" xChannelSelector="R" yChannelSelector="G" />' +
    '<feColorMatrix type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" result="displacedR" />' +
    '<feDisplacementMap in="SourceGraphic" in2="displacementMap" scale="' + (strength + cab) + '" xChannelSelector="R" yChannelSelector="G" />' +
    '<feColorMatrix type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" result="displacedG" />' +
    '<feDisplacementMap in="SourceGraphic" in2="displacementMap" scale="' + strength + '" xChannelSelector="R" yChannelSelector="G" />' +
    '<feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" result="displacedB" />' +
    '<feBlend in="displacedR" in2="displacedG" mode="screen" />' +
    '<feBlend in2="displacedB" mode="screen" />' +
    '</filter></defs></svg>';
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg) + '#displace';
}
