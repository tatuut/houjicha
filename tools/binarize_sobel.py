#!/usr/bin/env python3
import numpy as np
from PIL import Image

# Sobel mag読み込み
img = np.array(Image.open('docs/images/kirinuki_indo_sobel_mag.png'))
print(f'値の範囲: {img.min()} - {img.max()}')
print(f'平均: {img.mean():.1f}')

# 複数の閾値で二値化
thresholds = [1, 3, 5, 10, 15, 20, 30]
for t in thresholds:
    binary = (img >= t).astype(np.uint8) * 255
    path = f'docs/images/kirinuki_indo_sobel_binary_{t}.png'
    Image.fromarray(binary).save(path)
    white_ratio = (img >= t).mean() * 100
    print(f'閾値 {t:2d}: 白の割合 {white_ratio:.1f}% -> {path}')

print('完了!')
