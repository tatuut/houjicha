#!/usr/bin/env python3
"""顔部分を切り出し"""
from PIL import Image

img = Image.open('docs/images/kirinuki_indo_sobel_binary_30.png')

# 顔部分を切り出し（X:350-550, Y:120-350）
face = img.crop((350, 120, 550, 350))
face.save('docs/images/kirinuki_indo_face.png')
print(f'顔部分を切り出し: {face.size}')
