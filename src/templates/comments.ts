export interface CommentsParams {
  assignment: string;
  timestamp: string;
}

export type CommentType = 'question' | 'note' | 'feedback';

export interface Comment {
  id: string;
  timestamp: string;
  author: string;
  type: CommentType;
  body: string;
  replyTo?: string;
  resolved?: boolean;
}

export function renderComments(params: CommentsParams): string {
  return `---
assignment: ${params.assignment}
entryCount: 0
generated: "${params.timestamp}"
updated: "${params.timestamp}"
---

# Comments

No comments yet.
`;
}

export function formatCommentEntry(comment: Comment): string {
  const lines: string[] = [];
  lines.push(`## ${comment.id}`);
  lines.push('');
  lines.push(`**Recorded:** ${comment.timestamp}`);
  lines.push(`**Author:** ${comment.author}`);
  lines.push(`**Type:** ${comment.type}`);
  if (comment.replyTo) {
    lines.push(`**Reply to:** ${comment.replyTo}`);
  }
  if (comment.type === 'question') {
    lines.push(`**Resolved:** ${comment.resolved ? 'true' : 'false'}`);
  }
  lines.push('');
  lines.push(comment.body.trim());
  lines.push('');
  return lines.join('\n');
}
