import { ProjectFrame } from "@/components/project-frame";
import { ProjectProvider } from "@/components/project-context";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return (
    <ProjectProvider projectId={projectId}>
      <ProjectFrame>{children}</ProjectFrame>
    </ProjectProvider>
  );
}
