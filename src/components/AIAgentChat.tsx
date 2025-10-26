import React from 'react'
import { type FC } from 'react'

import { Retool } from '@tryretool/custom-component-support'

export const AIAgentChat: FC = () => {
  Retool.useComponentSettings({ defaultWidth: 6, defaultHeight: 8 })

  const [text] = Retool.useStateString({
    name: 'text',
    label: 'Text',
    inspector: 'text',
    initialValue: 'Hello world'
  })

  return (
    <div style={{ padding: 12, fontFamily: 'Inter, sans-serif' }}>
      Hello {text}!
    </div>
  )
}


