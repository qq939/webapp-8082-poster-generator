import os
import smtplib
import mimetypes
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.mime.application import MIMEApplication
from typing import List, Optional
import dotenv
# 加载环境变量
dotenv.load_dotenv()
dotenv.load_dotenv("asset/.env")
# 全局参数
# 默认目标邮箱
DEFAULT_TARGET_EMAIL = "939342547@qq.com"  # 使用位置: send_email 函数参数默认值
# 默认 SMTP 服务器 (QQ邮箱)
DEFAULT_SMTP_SERVER = "smtp.qq.com"       # 使用位置: send_email 函数中获取配置
# 默认 SMTP 端口 (SSL)
DEFAULT_SMTP_PORT = 465                   # 使用位置: send_email 函数中获取配置
def send_email(
    subject: str,
    body: str,
    attachments: Optional[List[str]] = None,
    to_email: str = DEFAULT_TARGET_EMAIL
) -> bool:
    """
    发送邮件 Skill
    
    Args:
        subject: 邮件标题
        body: 邮件正文
        attachments: 附件文件路径列表
        to_email: 收件人邮箱，默认为 939342547@qq.com
        
    Returns:
        bool: 发送是否成功
    """
    # 获取配置
    sender_email = os.getenv("EMAIL_SENDER")
    sender_password = os.getenv("EMAIL_PASSWORD")
    smtp_server = os.getenv("SMTP_SERVER", DEFAULT_SMTP_SERVER)
    smtp_port = int(os.getenv("SMTP_PORT", DEFAULT_SMTP_PORT))
    if not sender_email or not sender_password:
        print("Error: EMAIL_SENDER or EMAIL_PASSWORD environment variables not set.")
        return False
    # 构建邮件
    msg = MIMEMultipart()
    msg["Subject"] = subject
    msg["From"] = sender_email
    msg["To"] = to_email
    # 添加正文
    msg.attach(MIMEText(body, "plain", "utf-8"))
    # 添加附件
    if attachments:
        for file_path in attachments:
            if not os.path.exists(file_path):
                print(f"Warning: Attachment not found: {file_path}")
                continue
            
            try:
                with open(file_path, "rb") as f:
                    file_data = f.read()
                    file_name = os.path.basename(file_path)
                    
                # 猜测 MIME 类型
                mime_type, _ = mimetypes.guess_type(file_path)
                if mime_type is None:
                    mime_type = "application/octet-stream"
                
                # 创建附件对象
                # 这里简单处理，统一用 MIMEApplication 或根据类型
                # 为了通用性，使用 MIMEApplication
                part = MIMEApplication(file_data, Name=file_name)
                part["Content-Disposition"] = f'attachment; filename="{file_name}"'
                msg.attach(part)
            except Exception as e:
                print(f"Error attaching file {file_path}: {e}")
    # 发送邮件
    try:
        # 使用 SMTP_SSL
        with smtplib.SMTP_SSL(smtp_server, smtp_port) as server:
            server.login(sender_email, sender_password)
            server.send_message(msg)
        print(f"Email sent successfully to {to_email}")
        return True
    except Exception as e:
        print(f"Failed to send email: {e}")
        return False
if __name__ == "__main__":
    send_email(
        subject="Test Attachment",
        body="Body with attachment"
    )
