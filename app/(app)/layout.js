import { ConsoleHeader } from "@/components/console/ConsoleHeader";

export const metadata = {
  title: "Coordination investigation",
};

export default function AppShellLayout({ children }) {
  return (
    <div className="cm-scanlines min-h-screen bg-cm-bg">
      <ConsoleHeader />
      {children}
    </div>
  );
}
