import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as apigwv2Int from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as ddb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as cw from 'aws-cdk-lib/aws-cloudwatch';
import * as cwActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';

export interface WecomMcpStackProps extends cdk.StackProps {
  /** 多应用隔离用。空串沿用默认名，与参考实现的 slug 约定一致 */
  readonly slug?: string;
  /** 允许的 OAuth redirect_uri host 白名单（精确比对，不含 loopback，后者恒许） */
  readonly allowedRedirectHosts?: string[];
  /** 可选：WAFv2 WebACL ARN。WebACL 本身不在此栈创建，只按 ARN 挂载 */
  readonly webAclArn?: string;
  /**
   * 可选：AgentCore Runtime 的执行角色 ARN。
   * Runtime 由部署脚本用 boto3 创建（CDK 无成熟构造），首次 synth 时角色可能还不存在，
   * 所以做成可选 —— 未传时需在角色创建后另行授予 CMK 与 secret 权限。
   */
  readonly runtimeRoleArn?: string;
}

/**
 * 企业微信托管远程 MCP 服务 —— 基建栈。
 *
 * 与参考实现（infra/lib/oauth-stack.ts，615 行）的差异：
 *
 *  ✗ 不需要 EventBridge 刷新规则。wecom-cli 在每次真实调用中自行刷新 access token，
 *    容器按 credentials.enc 的 mtime 判定并回写 —— 集中刷新的 cron 没有存在意义。
 *    （遗留风险：长期不活跃用户的凭证是否会过期未验证，见 lambda/oauth/index.js 注释）
 *
 *  ✗ 不需要 OpenIdMap 表。userId 是我们自造的不透明标识（企业微信是扫码，
 *    授权前就得有键），企业微信身份由凭证自然携带。
 *
 *  ✚ 多一张 AuthFlows 表。扫码是异步的：/authorize 起会话后要把
 *    userId / redirect_uri / code_challenge / 容器 sessionId 存下来，等轮询回来再签发 code。
 *    TTL 与 CLI 内部的 300s 扫码超时对齐。
 *
 *  ✚ middleware 不再需要 KMS Decrypt。飞书版要把 SaaS 令牌读出来塞 header；
 *    企业微信凭证是目录 blob、只能容器物化，middleware 只传 userId。攻击面更小。
 *
 * AgentCore Runtime **不在此栈**：CDK 当时无成熟构造，参考实现用 inline boto3
 * 做 create/update-on-conflict + endpoint 生命周期（deploy.sh:1573-1631）。本项目沿用。
 * 因此 RUNTIME_ARN 在 CDK 阶段未知，需部署脚本在 AgentCore 就绪后回填 Lambda 环境变量。
 * ⚠️ update-function-configuration 会**替换整个 env**，回填时必须把其他变量一并重传。
 */
export class WecomMcpStack extends cdk.Stack {
  public readonly endpoint: string;

  constructor(scope: Construct, id: string, props: WecomMcpStackProps = {}) {
    super(scope, id, props);

    const slug = props.slug ?? '';
    const sfx = slug ? `-${slug}` : '';
    const prefix = slug ? `wecom-mcp-on-agentcore/${slug}` : 'wecom-mcp-on-agentcore';

    // ---------- KMS ----------
    // 每应用一把 CMK。RETAIN：密钥随栈销毁会让已存凭证永久不可解密，
    // 而重新授权会新建机器人并丢失对旧产物的写权限（§14）—— 代价比孤儿密钥大得多。
    const cmk = new kms.Key(this, 'UserSecretKey', {
      description: `WeCom MCP per-user credential blobs${sfx}`,
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ---------- DynamoDB ----------
    // 本地 authorization_code。单次消费靠 DeleteItem + ReturnValues=ALL_OLD 原子领取。
    const codes = new ddb.Table(this, 'OAuthCodes', {
      tableName: `wecom-mcp-oauth-codes${sfx}`,
      partitionKey: { name: 'code', type: ddb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,   // 短命数据，可重建
    });

    // 扫码流程状态。TTL 对齐 CLI 内部硬编码的 300s 扫码超时。
    const flows = new ddb.Table(this, 'AuthFlows', {
      tableName: `wecom-mcp-auth-flows${sfx}`,
      partitionKey: { name: 'flowId', type: ddb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // refresh token 的当前 jti。**每用户一条**，所以轮换就是 PutItem 覆盖，
    // 拿旧 jti 来换即可判定为重放。access token 是无状态 HMAC 不落库，
    // 但 refresh token 必须落库才能轮换与吊销 —— 见 shared/tokens.js 的说明。
    const refreshTokens = new ddb.Table(this, 'RefreshTokens', {
      tableName: `wecom-mcp-refresh-tokens${sfx}`,
      partitionKey: { name: 'userId', type: ddb.AttributeType.STRING },
      timeToLiveAttribute: 'ttl',
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      // 删表 = 所有人下次续期失败、必须重新扫码（并各自多一个机器人），
      // 但不会丢企业微信凭证本体（那个在 Secrets Manager，是 RETAIN）。
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // 真人企业微信身份 → 当前在用的凭证槽位。
    // 同一个人每走一遍授权都会拿到新的随机 userId（扫码前无从得知他是谁），
    // 这张表把它们收敛成一条，于是：凭证列表变成真实名册、撤销一个人只删一条、
    // 重新授权可以复用旧槽位从而**不丢对旧机器人所建对象的写权限**。
    const identities = new ddb.Table(this, 'Identities', {
      tableName: `wecom-mcp-identities${sfx}`,
      partitionKey: { name: 'wecomUserId', type: ddb.AttributeType.STRING },
      billingMode: ddb.BillingMode.PAY_PER_REQUEST,
      // 没有 TTL：这是长期名册，不是短命数据。
      // 删表 = 丢失人到槽位的对应，下次授权会当成新人另开槽位（旧凭证成孤儿）。
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ---------- SSM 根密钥（外部创建） ----------
    // 签名根密钥由部署脚本写入 SecureString；CDK 只授予读权限。
    // 不由 CDK 创建：一旦栈重建就会换掉根密钥，所有已签发的 MCP token 立即失效。
    const stateSecretParam = `/${prefix}/state-secret`;
    const stateSecretArn = cdk.Arn.format(
      { service: 'ssm', resource: 'parameter', resourceName: stateSecretParam.slice(1) }, this,
    );

    // ---------- Lambda ----------
    const commonEnv: Record<string, string> = {
      DEPLOY_REGION: this.region,
      STATE_SECRET_PARAM: stateSecretParam,
      SECRET_PREFIX: `${prefix}/users`,
      USER_SECRET_KMS_KEY_ARN: cmk.keyArn,
      // AUTHORIZE_BASE / RUNTIME_ARN 在 CloudFront 与 AgentCore 就绪后由部署脚本回填
      AUTHORIZE_BASE: '',
      RUNTIME_ARN: '',
    };

    // Lambda asset 的依赖已被裁到最小。
    //
    // 运行时内置 AWS SDK v3（lambda/latest/dg/nodejs-package.html → Runtime dependencies），
    // 所以 @aws-sdk/client-ssm / client-dynamodb 不打包。
    // **但实测运行时只暴露 @aws-sdk/client-*** —— `@smithy/*` 与 `@aws-crypto/*` 无法直接
    // require，漏了会在冷启动就报
    //   Runtime.ImportModuleError: Cannot find module '@smithy/signature-v4'
    // 所以这三个（signature-v4 / protocol-http / sha256-js）必须随包上传。
    //
    // 为什么在意体积：**每改一行 Lambda 代码就要重传整个 asset**（内容 hash 变了）。
    // 带全套 SDK 时 asset 22MB，实测在跨境链路上 30 分钟都没传完、一次部署直接卡死；
    // 裁到只剩这三个后约 7.6MB（压缩后 1-2MB），部署秒级完成。
    //
    // 代价（按共享责任模型明确接受）：运行时 SDK 版本由 AWS 决定并会漂移。
    // 若将来用到运行时没有的 @aws-sdk 包，要么加进 dependencies，要么改用
    // esbuild 打包 / Lambda layer。
    const lambdaCode = lambda.Code.fromAsset('../lambda', {
      exclude: ['package-lock.json', '*.md', 'node_modules/**/*.ts', 'node_modules/**/*.map'],
    });

    const oauthFn = new lambda.Function(this, 'OAuthFunction', {
      functionName: `${this.stackName}-oauth`,
      // nodejs20.x 已于 2026-04-30 弃用，**2027-02-01 起禁止创建函数**、2027-03-03 起禁止更新
      //（lambda/latest/dg/lambda-runtimes.html → Deprecated runtimes）。
      // 选 24 而不是 22：22 的弃用日是 2027-04-30，24 是 2028-04-30，多一年缓冲。
      // 刻意写死版本而不用 Runtime.NODEJS_LATEST —— 后者随 CDK 升级会**静默改变**运行时，
      // 本项目依赖「运行时自带 AWS SDK v3」这个前提，不该让它在无人察觉时移动。
      runtime: lambda.Runtime.NODEJS_24_X,
      architecture: lambda.Architecture.ARM_64,
      handler: 'oauth/index.handler',
      code: lambdaCode,
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      logGroup: new logs.LogGroup(this, 'OAuthLogGroup', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: {
        ...commonEnv,
        OAUTH_CODES_TABLE: codes.tableName,
        AUTH_FLOWS_TABLE: flows.tableName,
        REFRESH_TOKENS_TABLE: refreshTokens.tableName,
        IDENTITIES_TABLE: identities.tableName,
        ALLOWED_REDIRECT_HOSTS: (props.allowedRedirectHosts ?? []).join(','),
        // OAUTH_CLIENT_SECRET 由部署脚本注入（Quick 走共享密钥这条路，不走 DCR）
      },
    });

    const middlewareFn = new lambda.Function(this, 'MiddlewareFunction', {
      functionName: `${this.stackName}-middleware`,
      runtime: lambda.Runtime.NODEJS_24_X,      // 与 oauth 一致，理由见上
      architecture: lambda.Architecture.ARM_64,
      handler: 'mcp-middleware/index.handler',
      code: lambdaCode,
      timeout: cdk.Duration.seconds(29),          // 贴住 API Gateway 上限
      memorySize: 512,
      reservedConcurrentExecutions: 50,           // 防单用户打爆账号并发
      logGroup: new logs.LogGroup(this, 'MiddlewareLogGroup', {
        retention: logs.RetentionDays.ONE_MONTH,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }),
      environment: commonEnv,
    });

    // ---------- IAM ----------
    codes.grantReadWriteData(oauthFn);
    flows.grantReadWriteData(oauthFn);
    refreshTokens.grantReadWriteData(oauthFn);
    identities.grantReadWriteData(oauthFn);
    oauthFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'], resources: [stateSecretArn],
    }));
    // 只给 DescribeSecret，**不给 GetSecretValue**。
    // oauth Lambda 需要判断「用户凭证是否已落库」来确认授权完成 —— 容器把授权会话
    // 存在进程内存里，而 AgentCore 多实例分发会让状态查询打到没有该会话的实例，
    // 返回 unknown 让页面永远干等（实测撞到过）。密钥是跨实例的持久信号。
    // 但 Lambda 永远不需要凭证**内容**，所以不授予读取权限，也就拿不到。
    oauthFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['secretsmanager:DescribeSecret'],
      resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:${prefix}/users/*`],
    }));
    middlewareFn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['ssm:GetParameter'], resources: [stateSecretArn],
    }));

    // 两个 Lambda 都要能调 AgentCore Runtime（oauth 走 wecom/auth.* 控制面方法）。
    // RUNTIME_ARN 未知，只能按前缀授权；部署脚本回填 ARN 后可收窄。
    const runtimeArnPattern = cdk.Arn.format(
      { service: 'bedrock-agentcore', resource: 'runtime', resourceName: '*' }, this,
    );
    for (const fn of [oauthFn, middlewareFn]) {
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeAgentRuntime'],
        resources: [runtimeArnPattern, `${runtimeArnPattern}/*`],
      }));
    }

    // 容器角色需要读写 per-user secret 并用 CMK 加解密。
    // 注意：middleware **不需要** KMS 权限（它不碰凭证），这是与参考实现的重要差异。
    //
    // AgentCore Runtime 及其执行角色由部署脚本用 boto3 创建（不在此栈），所以角色 ARN
    // 在 CDK 阶段可能还不存在。传入了就在这里授权，没传就必须由部署脚本在建角色后补授。
    if (props.runtimeRoleArn) {
      cmk.grantEncryptDecrypt(new iam.ArnPrincipal(props.runtimeRoleArn));
    } else {
      new cdk.CfnOutput(this, 'RuntimeRoleGrantPending', {
        value: 'runtimeRoleArn 未传入：AgentCore 执行角色需在创建后另行授予 CMK 加解密与 secret 读写权限',
      });
    }

    // ---------- API Gateway（HTTP API，不能用 REST API） ----------
    //
    // ⚠️ 必须是 HTTP API。REST API 会把响应头 `WWW-Authenticate` 改名成
    // `X-Amzn-Remapped-WWW-Authenticate`（官方文档 api-gateway-known-issues.html
    // 的 REST API 注意事项表里明确列了：Response = Remapped），而 MCP 客户端按
    // RFC 9728 找的就是 `WWW-Authenticate` —— 改名后整条发现流程走不通。
    // 实测确认：用 REST API 时 401 响应里只有 x-amzn-remapped-www-authenticate。
    // HTTP API 的注意事项里没有任何响应头改名。
    //
    // 附带好处：HTTP API 用 payload v2，Lambda 侧 event.rawPath /
    // event.requestContext.http.method 更直白，且价格更低。
    // construct id 刻意用 HttpApi 而非 Api：CloudFormation 不允许同一 logical ID
    // 原地改变资源类型（RestApi → HttpApi 会报 "Update of resource type is not
    // permitted"），换 id 才能走「新建 + 删旧」。
    const api = new apigwv2.HttpApi(this, 'HttpApi', {
      apiName: `${this.stackName}-api`,
      description: 'WeCom MCP：OAuth 授权服务器 + MCP 数据面',
    });

    const oauthI = new apigwv2Int.HttpLambdaIntegration('OAuthInt', oauthFn);
    const mwI = new apigwv2Int.HttpLambdaIntegration('MwInt', middlewareFn);

    api.addRoutes({ path: '/authorize', methods: [apigwv2.HttpMethod.GET], integration: oauthI });
    api.addRoutes({ path: '/authorize/status', methods: [apigwv2.HttpMethod.GET], integration: oauthI });
    // 自助取 token：给 Quick Desktop 这类只能填 Header、没有 OAuth 流程的客户端
    api.addRoutes({ path: '/authorize/self', methods: [apigwv2.HttpMethod.GET], integration: oauthI });
    api.addRoutes({ path: '/authorize/self/status', methods: [apigwv2.HttpMethod.GET], integration: oauthI });
    api.addRoutes({ path: '/token', methods: [apigwv2.HttpMethod.POST], integration: oauthI });
    api.addRoutes({ path: '/register', methods: [apigwv2.HttpMethod.POST], integration: oauthI });
    api.addRoutes({
      path: '/.well-known/{proxy+}',
      methods: [apigwv2.HttpMethod.GET],
      integration: oauthI,
    });
    api.addRoutes({
      path: '/mcp',
      methods: [apigwv2.HttpMethod.POST, apigwv2.HttpMethod.GET, apigwv2.HttpMethod.DELETE],
      integration: mwI,
    });

    // stage 级限流。即使 WAF 未启用或被绕过也生效。
    const stage = api.defaultStage!.node.defaultChild as apigwv2.CfnStage;
    stage.defaultRouteSettings = { throttlingRateLimit: 50, throttlingBurstLimit: 100 };

    const apiDomain = `${api.apiId}.execute-api.${this.region}.${this.urlSuffix}`;

    // ---------- CloudFront ----------
    const dist = new cloudfront.Distribution(this, 'Cf', {
      defaultBehavior: {
        origin: new origins.HttpOrigin(apiDomain, {
          protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
        }),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
        cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
        originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      },
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      webAclId: props.webAclArn,
      comment: `WeCom MCP${sfx}`,
    });
    this.endpoint = `https://${dist.distributionDomainName}`;

    // ---------- 告警（最小集） ----------
    const topic = new sns.Topic(this, 'AlarmTopic', { displayName: `WeCom MCP alarms${sfx}` });
    const action = new cwActions.SnsAction(topic);

    // 凭证回写失败：容器打 CRITICAL credential_writeback_failed / auth_writeback_failed。
    // 这是最要紧的一条 —— 凭证丢了用户必须重新授权，而重新授权会新建机器人并
    // **永久失去对旧产物的写权限**（§14）。
    //
    // ⚠️ MetricFilter 不能建在这里：这两条日志由**容器**打出，落在
    // /aws/bedrock-agentcore/runtimes/<runtimeId>-{DEFAULT,ep}，而 runtimeId 在 CDK
    // 阶段还不存在（Runtime 由 scripts/agentcore.py 用 boto3 创建）。
    // 早期版本把 filter 挂在了 middleware 的 log group 上 —— 语法通过、部署成功、
    // **但这条告警永远不会触发**，是最坏的一种错。
    // 现在 filter 由 scripts/deploy.sh 在 Runtime READY 之后用 put-metric-filter 建，
    // 告警只按 namespace/metricName 引用；filter 尚未创建时 NOT_BREACHING 保证不误报。
    const writebackMetric = new cw.Metric({
      namespace: 'WecomMcp',
      metricName: 'CredentialWritebackLost',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    new cw.Alarm(this, 'WritebackLostAlarm', {
      metric: writebackMetric,
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      alarmDescription: '凭证回写失败：用户会以为授权成功但凭证未落库',
    }).addAlarmAction(action);

    for (const [name, fn] of [['OAuth', oauthFn], ['Middleware', middlewareFn]] as const) {
      new cw.Alarm(this, `${name}ErrorAlarm`, {
        metric: fn.metricErrors({ period: cdk.Duration.minutes(5) }),
        threshold: 5,
        evaluationPeriods: 1,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(action);
    }

    // TODO: 参考实现有 11 个告警 + ~15 个日志 MetricFilter + 5 板块 Dashboard。
    // 这里只落了最要紧的三条，其余（AgentCore 5xx、MCP p95 延迟、并发、限流、
    // API 5xx、企业微信侧慢调用）待补。

    // ---------- ARM 远程构建（给没有 ARM64 机器的部署者） ----------
    //
    // AgentCore Runtime **只跑 ARM64**（bedrock-agentcore/latest/devguide →
    // "AgentCore Runtime runs on ARM64 (AWS Graviton)... only images built for ARM64 will work"）。
    // 在 x86 机器上直接 docker build 会以 `exec /bin/sh: exec format error` 失败，
    // 官方给的出路是 buildx 交叉构建或 CodeBuild —— 这里选 CodeBuild：
    // 部署者本地**完全不需要**容器运行时，Windows / Intel Mac 也能部署。
    //
    // ⚠️ ARM_CONTAINER 并非所有区域都有。与 Quick Suite 的 7 个区取交集后，
    // 唯一落空的是 eu-west-2（伦敦）—— 选那个区就只能自备 ARM64 机器。
    const buildSource = new s3.Bucket(this, 'BuildSource', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // 源码 zip 是过程产物，留着只会攒垃圾
      lifecycleRules: [{ expiration: cdk.Duration.days(7) }],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // ECR 仓库由 deploy.sh 步骤④创建（CDK 跑在它之前），这里只按名引用拿授权用。
    // fromRepositoryName 是纯 token 引用、synth 期不查真实资源，所以仓库还不存在也能过。
    const imageRepo = ecr.Repository.fromRepositoryName(
      this, 'ImageRepo', `wecom-mcp${sfx}`,
    );

    const imageBuild = new codebuild.Project(this, 'ImageBuild', {
      projectName: `${this.stackName}-image-build`,
      source: codebuild.Source.s3({ bucket: buildSource, path: 'source.zip' }),
      environment: {
        // aws/codebuild/amazonlinux-aarch64-standard:3.0，environmentType = ARM_CONTAINER
        buildImage: codebuild.LinuxArmBuildImage.AMAZON_LINUX_2023_STANDARD_3_0,
        computeType: codebuild.ComputeType.SMALL,
        // 在容器里跑 docker 必须开特权模式，否则 docker daemon 起不来
        privileged: true,
      },
      timeout: cdk.Duration.minutes(30),
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo "构建 $IMAGE_URI"',
              'aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "${IMAGE_URI%%/*}"',
            ],
          },
          build: {
            // 构建上下文是仓库根，Dockerfile 在 docker/ 下 —— 与本地构建保持一致
            commands: ['docker build --platform linux/arm64 -f docker/Dockerfile -t "$IMAGE_URI" .'],
          },
          post_build: {
            commands: ['docker push "$IMAGE_URI"'],
          },
        },
      }),
    });
    imageRepo.grantPullPush(imageBuild);

    new cdk.CfnOutput(this, 'BuildSourceBucket', { value: buildSource.bucketName });
    new cdk.CfnOutput(this, 'ImageBuildProject', { value: imageBuild.projectName });

    // ---------- 输出 ----------
    new cdk.CfnOutput(this, 'Endpoint', { value: this.endpoint });
    new cdk.CfnOutput(this, 'McpUrl', { value: `${this.endpoint}/mcp` });
    new cdk.CfnOutput(this, 'OAuthFunctionName', { value: oauthFn.functionName });
    new cdk.CfnOutput(this, 'MiddlewareFunctionName', { value: middlewareFn.functionName });
    new cdk.CfnOutput(this, 'UserSecretKmsKeyArn', { value: cmk.keyArn });
    new cdk.CfnOutput(this, 'StateSecretParam', { value: stateSecretParam });
    new cdk.CfnOutput(this, 'SecretPrefix', { value: `${prefix}/users` });
  }
}
