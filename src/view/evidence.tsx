import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

import type { Proof, ProofKind } from '../../review/shape.ts'

import { SMALL } from './comment.tsx'

/**
 * Evidence kept beside the review: screenshots drawn small (pressed, full size in a dialog), logs and
 * test output as a line (pressed, their text in a dialog). The files are this module's own, served
 * from the review's folder (`/api/evidence`) as a picture or as plain text, never as a page.
 */

const KIND_WORD: Record<ProofKind, string> = { screenshot: 'Screenshot', log: 'Log', test: 'Test output' }

const say = (error: unknown): string => (error instanceof Error ? error.message : String(error))

export interface EvidenceAccess {
  /** Where a file is served, for an `<img>`. */
  src(id: string): string
  /** A text file's words. */
  text(id: string): Promise<string>
}

type Opened = { proof: Proof; text?: string; error?: string } | null

export function EvidenceList({
  proofs,
  access,
  small = false,
  onDrop,
  points,
}: {
  proofs: readonly Proof[]
  access: EvidenceAccess
  /** On a point's card: thumbnails and captions only. */
  small?: boolean
  /** The person removes one (two presses). Absent on a point's card. */
  onDrop?(id: string): Promise<void>
  /** A point's label by id, to say which point a piece of evidence supports. */
  points?: ReadonlyMap<string, string>
}) {
  const [opened, setOpened] = useState<Opened>(null)
  const open = (proof: Proof) => {
    setOpened({ proof })
    if (proof.kind !== 'screenshot') {
      access
        .text(proof.id)
        .then((text) => setOpened((was) => (was?.proof.id === proof.id ? { proof, text } : was)))
        .catch((e: unknown) => setOpened((was) => (was?.proof.id === proof.id ? { proof, error: say(e) } : was)))
    }
  }
  if (!proofs.length) return null
  return (
    <>
      <ul className={cn('flex min-w-0 flex-wrap gap-1.5', small ? '' : 'flex-col')} data-testid={small ? 'point-evidence' : 'evidence'}>
        {proofs.map((proof) => (
          <li key={proof.id} className={cn('flex min-w-0 gap-1.5', small ? 'max-w-[9rem] flex-col' : 'items-start rounded-md border bg-card p-1.5')} data-evidence={proof.id}>
            <button type="button" className="shrink-0 text-left" onClick={() => open(proof)} title={`Open: ${proof.caption}`}>
              {proof.kind === 'screenshot' ? (
                <img
                  src={access.src(proof.id)}
                  alt={proof.caption}
                  loading="lazy"
                  referrerPolicy="no-referrer"
                  className={cn('rounded-sm border object-cover object-top', small ? 'h-14 w-24' : 'h-20 w-32')}
                />
              ) : (
                <span className={cn('flex items-center justify-center rounded-sm border bg-muted font-mono text-[0.65rem]', small ? 'h-8 w-24' : 'h-12 w-32')}>
                  {KIND_WORD[proof.kind]}
                </span>
              )}
            </button>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5 text-[0.7rem] leading-4">
              <span className={cn('min-w-0 [overflow-wrap:anywhere]', small && 'line-clamp-2')}>{proof.caption}</span>
              {small ? null : (
                <span className="text-muted-foreground">
                  {KIND_WORD[proof.kind]}, {proof.by === 'agent' ? `collected by an agent${proof.run ? ` (run ${proof.run})` : ''}` : 'added by you'}
                  {proof.point ? ` · on ${points?.get(proof.point) ?? proof.point}` : ''}
                </span>
              )}
              {onDrop ? <Remove onDrop={() => onDrop(proof.id)} /> : null}
            </div>
          </li>
        ))}
      </ul>
      <Dialog open={opened !== null} onOpenChange={(open) => !open && setOpened(null)}>
        <DialogContent className="max-h-[90vh] max-w-[95vw] overflow-auto p-3">
          {opened ? (
            <>
              <DialogHeader>
                <DialogTitle className="text-sm">{opened.proof.caption}</DialogTitle>
                <DialogDescription className="text-[0.7rem]">
                  {KIND_WORD[opened.proof.kind]} · {opened.proof.file} · {opened.proof.bytes} bytes
                </DialogDescription>
              </DialogHeader>
              {opened.proof.kind === 'screenshot' ? (
                <img src={access.src(opened.proof.id)} alt={opened.proof.caption} referrerPolicy="no-referrer" className="max-w-full" data-testid="evidence-full" />
              ) : opened.error ? (
                <p role="alert" className="text-[0.7rem]">
                  {opened.error}
                </p>
              ) : (
                <pre className="max-h-[70vh] overflow-auto rounded-sm bg-muted p-2 font-mono text-[0.65rem] leading-4 whitespace-pre" data-testid="evidence-text">
                  {opened.text ?? 'Reading…'}
                </pre>
              )}
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  )
}

function Remove({ onDrop }: { onDrop(): Promise<void> }) {
  const [armed, setArmed] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <span className="flex flex-wrap items-center gap-1">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className={cn(SMALL, 'px-0', armed && 'text-destructive')}
        onBlur={() => setArmed(false)}
        onClick={() => {
          if (!armed) return setArmed(true)
          onDrop().catch((e: unknown) => {
            setError(say(e))
            setArmed(false)
          })
        }}
      >
        {armed ? 'Remove it?' : 'Remove'}
      </Button>
      {error ? <span role="alert">{error}</span> : null}
    </span>
  )
}
