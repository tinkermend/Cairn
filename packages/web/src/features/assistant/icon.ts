import icon70 from '@/assets/brand/assistant-observer-v1-70.webp?no-inline'
import icon140 from '@/assets/brand/assistant-observer-v1-140.webp?no-inline'
import icon210 from '@/assets/brand/assistant-observer-v1-210.webp?no-inline'

// Keep candidates as URLs so the browser downloads only the selected size.
export const assistantIcon = {
  src: icon70,
  srcSet: `${icon70} 70w, ${icon140} 140w, ${icon210} 210w`,
}
