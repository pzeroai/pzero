import type { ChatMessage } from "../store/dashboard";

export default function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";

  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] px-3 py-2 rounded-none text-sm leading-relaxed ${
          isUser
            ? "bg-green-600 text-white"
            : "bg-zinc-800 text-zinc-200"
        }`}
      >
        {msg.content}
      </div>
    </div>
  );
}
